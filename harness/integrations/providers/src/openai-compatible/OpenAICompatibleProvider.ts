import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import {
  createModelCallRef,
  createModelTurnId,
  createProviderAttemptInterruption,
  providerResultFromInterruption,
  snapshotProviderResponse,
  type ModelJsonValue,
  type ModelInstructions,
  type ModelMessage,
  type ModelToolCall,
  type ModelTurnFinish,
  type Provider,
  type ProviderCallResult,
  type ProviderDescriptor,
  type ProviderFailure,
  type ProviderInteraction,
  type ProviderRequest,
  type ProviderResponse,
} from "@agent-anything/model-interaction";
import {
  createUtf8ModelInputAccounting,
  type ProviderModelInputAccounting,
} from "@agent-anything/model-interaction/input";
import {
  classifyProviderHttpFailure,
  readProviderHttpFailureMetadata,
} from "../http/ProviderHttpFailureMetadata.js";
import {
  boundProviderHttpDiagnosticText,
  createProviderHttpRequestDiagnostic,
  MAX_PROVIDER_HTTP_DIAGNOSTIC_ATTRIBUTE_LENGTH,
  MAX_PROVIDER_HTTP_DIAGNOSTIC_MESSAGE_LENGTH,
  renderProviderHttpRequestDiagnostic,
  type ProviderHttpRequestDiagnostic,
} from "../http/ProviderHttpDiagnostics.js";
import type { FetchLike } from "../http/ProviderHttpTransport.js";
import { decodeStructuredGenerationOutput } from "../structured-generation/StructuredGenerationResponse.js";

const PROVIDER_ID = "openai-compatible.chat-completions";
const MAX_RESPONSE_TEXT_LENGTH = 64_000;

interface OpenAICompatibleHttpErrorDiagnostic {
  readonly message: string | null;
  readonly type: string | null;
  readonly code: string | null;
  readonly param: string | null;
  readonly truncated: boolean;
}

export interface OpenAICompatibleProviderConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly nativeToolInteraction: {
    readonly supported: boolean;
  };
  readonly inputLimit: {
    readonly maximumBytes: number;
    readonly source: "provider_reported" | "host_configured";
  };
}

export class OpenAICompatibleProvider implements Provider {
  readonly descriptor: ProviderDescriptor;
  readonly inputAccounting: ProviderModelInputAccounting;

  constructor(
    config: OpenAICompatibleProviderConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch as FetchLike,
  ) {
    this.config = snapshotConfig(config);
    this.inputAccounting = createUtf8ModelInputAccounting({
      providerId: PROVIDER_ID,
      model: this.config.model,
      maximumInputBytes: this.config.inputLimit.maximumBytes,
      limitSource: this.config.inputLimit.source,
      estimator: { id: "openai-compatible.utf8-content", revision: "1" },
      framing: { id: "openai-compatible.chat-completions-framing", revision: "3" },
      renderRequest: (instructions, messages, interaction) =>
        encodeOpenAIRequest(this.config.model, instructions, messages, interaction),
    });
    this.descriptor = Object.freeze({
      id: PROVIDER_ID,
      name: "OpenAI-compatible Chat Completions",
      capabilities: Object.freeze({
        nativeToolInteraction: this.config.nativeToolInteraction.supported
          ? Object.freeze({
              supported: true as const,
              callableDefinitions: true as const,
              modelCalls: true as const,
              resultMessages: true as const,
              multipleCalls: true,
              callCorrelation: "provider_supplied" as const,
            })
          : Object.freeze({ supported: false as const }),
        structuredGeneration: Object.freeze({ supported: true as const }),
        streaming: Object.freeze({ supported: false as const }),
        modelInput: this.inputAccounting.capability,
        continuation: Object.freeze({ supported: false as const }),
        compaction: Object.freeze({ supported: false as const }),
        usageMetering: Object.freeze({
          inputTokens: "unavailable" as const,
          outputTokens: "unavailable" as const,
          costUnits: "unavailable" as const,
        }),
      }),
      requestRetryScheduler: Object.freeze({ kind: "harness" as const }),
      metadata: Object.freeze({}),
    });
  }

  private readonly config: Readonly<OpenAICompatibleProviderConfig>;

  async send(
    request: ProviderRequest,
    context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    if (request.continuation !== null) {
      return failed(
        "invalid_request",
        "provider_continuation_unsupported",
        "OpenAI-compatible Chat Completions does not support this continuation Contract.",
      );
    }
    if (
      request.interaction.kind === "native_tool_turn" &&
      !this.config.nativeToolInteraction.supported
    ) {
      return failed(
        "unsupported",
        "provider_native_tool_interaction_unsupported",
        "The configured OpenAI-compatible endpoint and model profile does not declare native Tool interaction.",
      );
    }
    const encoded = prepareEncodedRequest(
      this.inputAccounting,
      this.config.model,
      request,
    );
    if (encoded.kind === "failed") return encoded.result;

    const attempt = createProviderAttemptInterruption(context, this.config.timeoutMs);
    try {
      const interruptedBeforeRequest = providerResultFromInterruption(attempt.cause);
      if (interruptedBeforeRequest !== null) return interruptedBeforeRequest;

      const response = await this.fetchImpl(this.endpointUrl(), {
        method: "POST",
        headers: this.headers(),
        body: encoded.body,
        signal: attempt.signal,
      });
      const interruptedAfterResponse = providerResultFromInterruption(attempt.cause);
      if (interruptedAfterResponse !== null) return interruptedAfterResponse;

      if (!response.ok) {
        const httpClassification = classifyProviderHttpFailure(response.status);
        const diagnostic = await readOpenAICompatibleHttpErrorDiagnostic(
          response,
          this.config.apiKey,
        );
        const interruptedAfterFailureBody = providerResultFromInterruption(attempt.cause);
        if (interruptedAfterFailureBody !== null) return interruptedAfterFailureBody;
        const contextWindowExceeded = isOpenAICompatibleContextWindowExceeded(diagnostic);
        const classification = contextWindowExceeded
          ? Object.freeze({
              category: "invalid_request",
              code: "provider_context_window_exceeded",
              message: "Provider rejected the request because the model context window was exceeded.",
            })
          : httpClassification;
        const requestDiagnostic = createProviderHttpRequestDiagnostic({
          operation: "chat_completions",
          request,
          encodedBody: encoded.body,
        });
        return failed(
          classification.category,
          classification.code,
          formatOpenAICompatibleHttpFailureMessage(
            classification.message,
            diagnostic,
            requestDiagnostic,
          ),
          {
            ...readProviderHttpFailureMetadata(response),
            metadata: {
              openAICompatibleError: diagnostic,
              requestDiagnostic,
            },
          },
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return providerResultFromInterruption(attempt.cause) ?? failed(
          "response",
          "provider_response_malformed",
          "Provider response body was not valid JSON.",
        );
      }
      const interruptedAfterBody = providerResultFromInterruption(attempt.cause);
      return interruptedAfterBody ?? mapChatCompletionResponse(body, request);
    } catch (error) {
      const interruption = providerResultFromInterruption(attempt.cause);
      if (interruption !== null) return interruption;
      return failed("transport", "provider_request_failed", "Provider request failed.", {
        metadata: { causeName: error instanceof Error ? error.name : null },
      });
    } finally {
      attempt.dispose();
    }
  }

  private endpointUrl(): string {
    return `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey.length > 0) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }
}

function prepareEncodedRequest(
  accounting: ProviderModelInputAccounting,
  model: string,
  request: ProviderRequest,
): { readonly kind: "encoded"; readonly body: string } |
  { readonly kind: "failed"; readonly result: ProviderCallResult } {
  try {
    accounting.verify({
      providerId: accounting.providerId,
      model: accounting.model,
      instructions: request.instructions,
      messages: request.messages,
      interaction: request.interaction,
      composition: request.composition,
    });
  } catch (error) {
    return Object.freeze({
      kind: "failed",
      result: failed(
        "invalid_request",
        "provider_input_accounting_invalid",
        "Provider request does not match its verified model-input composition.",
        { metadata: { causeName: error instanceof Error ? error.name : null } },
      ),
    });
  }
  try {
    const body = encodeOpenAIRequest(
      model,
      request.instructions,
      request.messages,
      request.interaction,
    );
    accounting.verifyEncoded({
      providerId: accounting.providerId,
      model: accounting.model,
      instructions: request.instructions,
      messages: request.messages,
      interaction: request.interaction,
      composition: request.composition,
      encodedRequest: body,
    });
    return Object.freeze({ kind: "encoded", body });
  } catch (error) {
    return Object.freeze({
      kind: "failed",
      result: failed(
        "invalid_request",
        "provider_input_encoding_invalid",
        "Provider request could not be encoded from its verified model input.",
        { metadata: { causeName: error instanceof Error ? error.name : null } },
      ),
    });
  }
}

function encodeOpenAIRequest(
  model: string,
  instructions: ModelInstructions,
  messages: readonly ModelMessage[],
  interaction: ProviderInteraction,
): string {
  return JSON.stringify({
    model,
    messages: interaction.kind === "native_tool_turn"
      ? encodeOpenAINativeMessages(instructions, messages)
      : [
          { role: "system", content: renderInstructions(instructions) },
          ...messages.map((message) => ({
          role: message.role,
          content: renderGenerationText(message),
          })),
        ],
    stream: false,
    ...(interaction.kind === "native_tool_turn"
      ? {
          tools: interaction.callables.map((callable) => ({
            type: "function",
            function: {
              name: callable.name,
              description: callable.description,
              parameters: callable.inputSchema,
            },
          })),
          tool_choice: "auto",
        }
      : interaction.kind === "structured_generation"
        ? { response_format: openAIResponseFormat(interaction.outputFormat) }
        : {}),
  });
}

function encodeOpenAINativeMessages(
  instructions: ModelInstructions,
  messages: readonly ModelMessage[],
): readonly unknown[] {
  const encoded: unknown[] = [{
    role: "system",
    content: renderInstructions(instructions),
  }];
  for (const message of messages) {
    if (message.role === "user") {
      encoded.push({ role: "user", content: renderInputText(message) });
      continue;
    }
    if (message.role === "tool") {
      for (const { result } of message.content) {
        if (
          result.providerCallRef === null ||
          result.providerCallRef.providerId !== PROVIDER_ID
        ) {
          throw new TypeError("OpenAI-compatible Tool results require exact Provider call correlation.");
        }
        encoded.push({
          role: "tool",
          tool_call_id: result.providerCallRef.id,
          content: renderToolResultContent(result.content),
        });
      }
      continue;
    }

    let text = "";
    let textBlockCount = 0;
    let sawCall = false;
    const calls: unknown[] = [];
    for (const block of message.content) {
      if (block.kind === "text") {
        if (sawCall || textBlockCount > 0) {
          throw new TypeError(
            "OpenAI-compatible assistant history must use at most one text block before Tool calls.",
          );
        }
        textBlockCount += 1;
        text += block.text;
      } else {
        sawCall = true;
        if (
          block.call.providerCallRef === null ||
          block.call.providerCallRef.providerId !== PROVIDER_ID
        ) {
          throw new TypeError("OpenAI-compatible assistant calls require exact Provider call correlation.");
        }
        calls.push({
          id: block.call.providerCallRef.id,
          type: "function",
          function: {
            name: block.call.name,
            arguments: JSON.stringify(block.call.input),
          },
        });
      }
    }
    encoded.push({
      role: "assistant",
      content: text.length === 0 ? null : text,
      ...(calls.length === 0 ? {} : { tool_calls: calls }),
    });
  }
  return encoded;
}

function openAIResponseFormat(
  outputFormat: Extract<ProviderInteraction, { readonly kind: "structured_generation" }>["outputFormat"],
) {
  return {
    type: "json_schema",
    json_schema: {
      name: outputFormat.name,
      schema: outputFormat.schema,
      strict: false,
    },
  };
}

function mapChatCompletionResponse(
  value: unknown,
  request: ProviderRequest,
): ProviderCallResult {
  return request.interaction.kind === "native_tool_turn"
    ? mapNativeChatCompletionResponse(value, request)
    : mapGeneratedChatCompletionResponse(value, request.interaction);
}

function mapNativeChatCompletionResponse(
  value: unknown,
  request: ProviderRequest,
): ProviderCallResult {
  try {
    const choice = readSingleChoice(value);
    if (!isRecord(choice.message)) {
      throw new TypeError("Chat Completion choice must contain a message.");
    }
    if (choice.message.role !== undefined && choice.message.role !== "assistant") {
      throw new TypeError("Chat Completion message role is invalid.");
    }
    const responseId = readOptionalIdentifier(
      isRecord(value) ? value.id : null,
      "Chat Completion response id",
    );
    const content = choice.message.content;
    if (content !== null && typeof content !== "string") {
      throw new TypeError("Chat Completion assistant content is invalid.");
    }
    if (typeof content === "string" && content.length > MAX_RESPONSE_TEXT_LENGTH) {
      return failed(
        "response",
        "provider_response_too_large",
        "Provider response content is too large.",
      );
    }
    const refusal = choice.message.refusal;
    if (refusal !== undefined && refusal !== null && typeof refusal !== "string") {
      throw new TypeError("Chat Completion refusal is invalid.");
    }
    const transportCalls = choice.message.tool_calls ?? [];
    if (!Array.isArray(transportCalls)) {
      throw new TypeError("Chat Completion Tool calls are malformed.");
    }
    if (typeof refusal === "string" && refusal.length > 0 && transportCalls.length > 0) {
      throw new TypeError("A refusal cannot contain executable Tool calls.");
    }

    const turnId = createModelTurnId({
      providerId: PROVIDER_ID,
      requestId: request.requestId,
      responseId,
    });
    const assistantContent: Array<
      | { readonly kind: "text"; readonly text: string }
      | { readonly kind: "model_tool_call"; readonly call: ModelToolCall }
    > = [];
    if (typeof content === "string" && content.length > 0) {
      assistantContent.push({ kind: "text", text: content });
    }
    for (const candidate of transportCalls) {
      const ordinal = assistantContent.length;
      assistantContent.push({
        kind: "model_tool_call",
        call: readOpenAIToolCall(candidate, request, turnId, ordinal),
      });
    }
    if (
      assistantContent.length === 0 &&
      !(typeof refusal === "string" && refusal.trim().length > 0)
    ) {
      return failed(
        "response",
        "provider_response_empty",
        "Provider returned an empty normal assistant turn.",
      );
    }

    return succeeded({
      kind: "native_tool_turn",
      turn: {
        turnId,
        assistant: { role: "assistant", content: assistantContent },
        finish: openAIFinish(
          choice.finish_reason,
          transportCalls.length > 0,
          typeof refusal === "string" ? refusal : null,
        ),
        usage: readUsage(isRecord(value) ? value.usage : null),
        responseRef: {
          providerId: PROVIDER_ID,
          requestId: request.requestId,
          responseId,
        },
      },
      continuation: null,
      metadata: {},
    });
  } catch (error) {
    return failed(
      "response",
      "provider_response_malformed",
      "Provider response could not be normalized safely.",
      { metadata: { causeName: error instanceof Error ? error.name : null } },
    );
  }
}

function readOpenAIToolCall(
  value: unknown,
  request: ProviderRequest,
  turnId: string,
  ordinal: number,
): ModelToolCall {
  if (!isRecord(value) || value.type !== "function" || !isRecord(value.function)) {
    throw new TypeError("Chat Completion Tool call must contain a function.");
  }
  const providerCallId = requiredString(value.id, "Chat Completion Tool call id");
  const name = requiredString(value.function.name, "Chat Completion Tool call name");
  if (typeof value.function.arguments !== "string") {
    throw new TypeError("Chat Completion Tool call arguments must be encoded JSON.");
  }
  const parsedArguments = JSON.parse(value.function.arguments) as unknown;
  if (!isRecord(parsedArguments)) {
    throw new TypeError("Chat Completion Tool call arguments must decode to a JSON object.");
  }
  return {
    modelCallRef: createModelCallRef({
      providerRequestId: request.requestId,
      controllerRequestId: request.correlation.controllerRequestId,
      turnId,
      contentBlockOrdinal: ordinal,
      branchId: request.correlation.branchId,
    }),
    providerCallRef: { providerId: PROVIDER_ID, id: providerCallId },
    name,
    input: parsedArguments as { readonly [key: string]: ModelJsonValue },
    ordinal,
  };
}

function openAIFinish(
  value: unknown,
  hasCalls: boolean,
  refusal: string | null,
): ModelTurnFinish {
  if (refusal !== null && refusal.trim().length > 0) {
    return { kind: "refusal", reason: refusal };
  }
  if (value === "length") return { kind: "output_limit" };
  if (value === "content_filter") return { kind: "content_filter" };
  if (hasCalls && (value === "tool_calls" || value === "stop")) {
    return { kind: "normal" };
  }
  if (value === "stop") return { kind: "normal" };
  return {
    kind: "unknown",
    safeCode: typeof value === "string" && value.trim().length > 0 && value.length <= 128
      ? value.trim()
      : null,
  };
}

function mapGeneratedChatCompletionResponse(
  value: unknown,
  interaction: Exclude<ProviderInteraction, { readonly kind: "native_tool_turn" }>,
): ProviderCallResult {
  try {
    const choice = readSingleChoice(value);
    if (!isRecord(choice.message) || typeof choice.message.content !== "string") {
      throw new TypeError("Chat Completion response did not contain generated content.");
    }
    if (choice.message.content.length > MAX_RESPONSE_TEXT_LENGTH) {
      return failed(
        "response",
        "provider_response_too_large",
        "Provider response content is too large.",
      );
    }
    if (interaction.kind === "structured_generation") {
      const decoded = decodeStructuredGenerationOutput(choice.message.content);
      if (decoded.kind === "failed") {
        return failed(
          "response",
          "provider_structured_output_malformed",
          "Provider structured output was not valid JSON.",
          { metadata: { causeName: decoded.causeName } },
        );
      }
      return succeeded({
        kind: "structured_generation",
        responseId: readOptionalIdentifier(
          isRecord(value) ? value.id : null,
          "Chat Completion response id",
        ),
        output: decoded.output,
        usage: readUsage(isRecord(value) ? value.usage : null),
        continuation: null,
        metadata: {},
      });
    }
    return succeeded({
      kind: "text_generation",
      responseId: readOptionalIdentifier(
        isRecord(value) ? value.id : null,
        "Chat Completion response id",
      ),
      output: choice.message.content,
      usage: readUsage(isRecord(value) ? value.usage : null),
      continuation: null,
      metadata: {},
    });
  } catch (error) {
    return failed(
      "response",
      "provider_response_malformed",
      "Provider response did not include generated content.",
      { metadata: { causeName: error instanceof Error ? error.name : null } },
    );
  }
}

function readSingleChoice(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length !== 1) {
    throw new TypeError("Chat Completion response must contain exactly one choice.");
  }
  const choice = value.choices[0];
  if (!isRecord(choice)) throw new TypeError("Chat Completion choice is malformed.");
  return choice;
}

function readUsage(value: unknown) {
  if (!isRecord(value)) return null;
  return {
    inputTokens: readCount(value.prompt_tokens),
    outputTokens: readCount(value.completion_tokens),
    totalTokens: readCount(value.total_tokens),
    costUnits: null,
    metadata: {},
  };
}

function renderGenerationText(message: ModelMessage): string {
  if (message.role === "tool") {
    throw new TypeError("Text and structured generation accept text-only Model Messages.");
  }
  return message.content.map((block) => {
    if (block.kind !== "text") {
      throw new TypeError("Text and structured generation accept text-only Model Messages.");
    }
    return block.text;
  }).join("\n\n");
}

function renderInputText(
  message: Extract<ModelMessage, { readonly role: "user" }>,
): string {
  return message.content.map((block) => block.text).join("\n\n");
}

function renderInstructions(instructions: ModelInstructions): string {
  return instructions.content.map((block) => block.text).join("\n\n");
}

function renderToolResultContent(value: ModelJsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function readOpenAICompatibleHttpErrorDiagnostic(
  response: { readonly json: () => Promise<unknown> },
  apiKey: string,
): Promise<OpenAICompatibleHttpErrorDiagnostic> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return emptyOpenAICompatibleHttpErrorDiagnostic();
  }
  if (!isRecord(body) || !isRecord(body.error)) {
    return emptyOpenAICompatibleHttpErrorDiagnostic();
  }
  const secrets = apiKey.length === 0 ? [] : [apiKey];
  const message = boundProviderHttpDiagnosticText(
    body.error.message,
    MAX_PROVIDER_HTTP_DIAGNOSTIC_MESSAGE_LENGTH,
    secrets,
  );
  const type = boundProviderHttpDiagnosticText(
    body.error.type,
    MAX_PROVIDER_HTTP_DIAGNOSTIC_ATTRIBUTE_LENGTH,
    secrets,
  );
  const code = boundProviderHttpDiagnosticText(
    body.error.code,
    MAX_PROVIDER_HTTP_DIAGNOSTIC_ATTRIBUTE_LENGTH,
    secrets,
  );
  const param = boundProviderHttpDiagnosticText(
    body.error.param,
    MAX_PROVIDER_HTTP_DIAGNOSTIC_ATTRIBUTE_LENGTH,
    secrets,
  );
  return Object.freeze({
    message: message.value,
    type: type.value,
    code: code.value,
    param: param.value,
    truncated: message.truncated || type.truncated || code.truncated || param.truncated,
  });
}

function emptyOpenAICompatibleHttpErrorDiagnostic(): OpenAICompatibleHttpErrorDiagnostic {
  return Object.freeze({
    message: null,
    type: null,
    code: null,
    param: null,
    truncated: false,
  });
}

function isOpenAICompatibleContextWindowExceeded(
  diagnostic: OpenAICompatibleHttpErrorDiagnostic,
): boolean {
  const markers = [diagnostic.code, diagnostic.type]
    .flatMap((value) => value === null ? [] : [value.toLowerCase()]);
  return markers.some((value) =>
    value === "context_length_exceeded" ||
    value === "context_window_exceeded" ||
    value === "input_too_long"
  );
}

function formatOpenAICompatibleHttpFailureMessage(
  message: string,
  diagnostic: OpenAICompatibleHttpErrorDiagnostic,
  request: ProviderHttpRequestDiagnostic,
): string {
  const providerMessage = diagnostic.message === null
    ? ""
    : ` Provider reported: ${diagnostic.message}${diagnostic.truncated ? " [truncated]" : ""}.`;
  const attributes = [
    diagnostic.type === null ? null : `type=${diagnostic.type}`,
    diagnostic.code === null ? null : `code=${diagnostic.code}`,
    diagnostic.param === null ? null : `param=${diagnostic.param}`,
  ].filter((value): value is string => value !== null);
  const providerAttributes = attributes.length === 0
    ? ""
    : ` Provider error attributes: ${attributes.join(", ")}.`;
  return `${message}${providerMessage}${providerAttributes} Request diagnostic: ` +
    `${renderProviderHttpRequestDiagnostic(request)}.`;
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function readOptionalIdentifier(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const result = requiredString(value, field);
  if (result.length > 256) throw new TypeError(`${field} is too large.`);
  return result;
}

function succeeded(response: ProviderResponse): ProviderCallResult {
  return { kind: "succeeded", response: snapshotProviderResponse(response) };
}

function failed(
  category: string,
  code: string,
  message: string,
  input: {
    statusCode?: number;
    retryAfterMs?: number;
    requestId?: string;
    metadata?: Record<string, unknown>;
  } = {},
): ProviderCallResult {
  const failure: ProviderFailure = {
    category,
    code,
    message,
    statusCode: input.statusCode,
    retryAfterMs: input.retryAfterMs,
    requestId: input.requestId,
    metadata: input.metadata ?? {},
  };
  return { kind: "failed", failure };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) throw new TypeError(`${field} is required.`);
  return normalized;
}

function snapshotConfig(
  input: OpenAICompatibleProviderConfig,
): Readonly<OpenAICompatibleProviderConfig> {
  if (
    !isRecord(input.nativeToolInteraction) ||
    typeof input.nativeToolInteraction.supported !== "boolean"
  ) {
    throw new TypeError("OpenAI-compatible native Tool interaction configuration is invalid.");
  }
  return Object.freeze({
    baseUrl: validatedBaseUrl(input.baseUrl),
    apiKey: requiredString(input.apiKey, "OpenAI-compatible API key", true),
    model: requiredString(input.model, "OpenAI-compatible model"),
    timeoutMs: positiveTimeout(input.timeoutMs),
    nativeToolInteraction: Object.freeze({
      supported: input.nativeToolInteraction.supported,
    }),
    inputLimit: snapshotInputLimit(input.inputLimit, "OpenAI-compatible"),
  });
}

function snapshotInputLimit(
  input: OpenAICompatibleProviderConfig["inputLimit"],
  owner: string,
): OpenAICompatibleProviderConfig["inputLimit"] {
  if (
    !isRecord(input) ||
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes <= 0 ||
    (input.source !== "provider_reported" && input.source !== "host_configured")
  ) {
    throw new TypeError(`${owner} input limit is invalid.`);
  }
  return Object.freeze({
    maximumBytes: input.maximumBytes,
    source: input.source,
  });
}

function validatedBaseUrl(value: string): string {
  const normalized = requiredString(value, "OpenAI-compatible base URL");
  const url = new URL(normalized);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new TypeError("OpenAI-compatible base URL must be an HTTP URL without credentials.");
  }
  return normalized;
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("OpenAI-compatible timeout must be a positive integer.");
  }
  return value;
}
