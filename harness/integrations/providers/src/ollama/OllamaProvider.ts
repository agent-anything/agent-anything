import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import {
  createModelCallRef,
  createUnknownModelInputMeasurement,
  createModelTurnId,
  createProviderAttemptInterruption,
  providerResultFromInterruption,
  snapshotProviderRequest,
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
  type ProviderModelContext,
  type ProviderRequest,
  type ProviderResponse,
} from "@agent-anything/model-interaction";
import {
  accountProviderTransport,
  verifyProviderTransportAccounting,
  type ProviderTransportAccounting,
  type ProviderTransportLimit,
} from "@agent-anything/model-interaction/transport";
import type { ModelInputComposition } from "@agent-anything/model-interaction/input";
import type { FetchLike } from "../http/ProviderHttpTransport.js";
import {
  classifyProviderHttpFailure,
  readProviderHttpFailureMetadata,
} from "../http/ProviderHttpFailureMetadata.js";
import {
  boundProviderHttpDiagnosticText,
  createProviderHttpRequestDiagnostic,
  MAX_PROVIDER_HTTP_DIAGNOSTIC_MESSAGE_LENGTH,
  renderProviderHttpRequestDiagnostic,
  type ProviderHttpRequestDiagnostic,
} from "../http/ProviderHttpDiagnostics.js";
import { decodeStructuredGenerationOutput } from "../structured-generation/StructuredGenerationResponse.js";
import { projectOllamaOutputFormat } from "./OllamaJsonSchemaDialect.js";

const PROVIDER_ID = "ollama.api";
const MAX_RESPONSE_TEXT_LENGTH = 64_000;

interface OllamaHttpErrorDiagnostic {
  readonly message: string | null;
  readonly truncated: boolean;
}

export interface OllamaProviderConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly runtime: {
    readonly contextWindowTokens: number;
    readonly maximumOutputTokens: number;
  };
  readonly nativeToolInteraction: {
    readonly supported: boolean;
  };
  readonly requestBodyTransportLimit: {
    readonly maximumBytes: number;
    readonly source: "provider_reported" | "host_configured";
    readonly revision: string;
  };
}

export class OllamaProvider implements Provider {
  readonly descriptor: ProviderDescriptor;
  readonly modelContext: ProviderModelContext;
  readonly requestBodyTransportLimit: ProviderTransportLimit;

  constructor(
    config: OllamaProviderConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch as FetchLike,
  ) {
    this.config = snapshotConfig(config);
    this.requestBodyTransportLimit = Object.freeze({
      ...this.config.requestBodyTransportLimit,
    });
    const target = Object.freeze({
      providerId: PROVIDER_ID,
      model: this.config.model,
      revision: `ollama.api.target.v1:${this.config.model}`,
    });
    const capacity = Object.freeze({
      supported: true as const,
      unit: "tokens" as const,
      maximum: this.config.runtime.contextWindowTokens,
      semantics: "input_and_output" as const,
      source: "host_configured" as const,
      providerId: PROVIDER_ID,
      model: this.config.model,
      revision: `ollama.api.context-window.v1:${this.config.runtime.contextWindowTokens}`,
    });
    const requestedOutput = Object.freeze({
      unit: "tokens" as const,
      maximum: this.config.runtime.maximumOutputTokens,
      source: "host_configured" as const,
      revision: `ollama.api.num-predict.v1:${this.config.runtime.maximumOutputTokens}`,
    });
    const inputPreservation = Object.freeze({
      providerId: PROVIDER_ID,
      model: this.config.model,
      adapterRevision: "ollama.api.adapter.v4",
      runtimeVersion: null,
      truncation: "unknown" as const,
      contextShift: "unknown" as const,
      evidence: Object.freeze([]),
      revision: "ollama.api.input-preservation.unqualified.v1",
    });
    const modelContext: ProviderModelContext = Object.freeze({
      target,
      capacity,
      requestedOutput,
      inputPreservation,
      measure(composition: ModelInputComposition, measuredAt: string) {
        return createUnknownModelInputMeasurement({
          compositionId: composition.id,
          measuredAt,
          reason: "unsupported",
        });
      },
    });
    this.modelContext = modelContext;
    this.descriptor = Object.freeze({
      id: PROVIDER_ID,
      name: "Ollama API",
      capabilities: Object.freeze({
        nativeToolInteraction: this.config.nativeToolInteraction.supported
          ? Object.freeze({
              supported: true as const,
              callableDefinitions: true as const,
              modelCalls: true as const,
              resultMessages: true as const,
              multipleCalls: true,
              callCorrelation: "adapter_assigned" as const,
            })
          : Object.freeze({ supported: false as const }),
        structuredGeneration: Object.freeze({ supported: true as const }),
        streaming: Object.freeze({ supported: false as const }),
        modelContext: Object.freeze({ capacity, requestedOutput, inputPreservation }),
        continuation: Object.freeze({ supported: false as const }),
        compaction: Object.freeze({ supported: false as const }),
        usageMetering: Object.freeze({
          inputTokens: "measured" as const,
          outputTokens: "measured" as const,
          costUnits: "not_applicable" as const,
        }),
      }),
      requestRetryScheduler: Object.freeze({ kind: "harness" as const }),
      metadata: Object.freeze({}),
    });
  }

  private readonly config: Readonly<OllamaProviderConfig>;

  async send(
    request: ProviderRequest,
    context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    try {
      request = snapshotProviderRequest(request);
    } catch (error) {
      return failed(
        "invalid_request",
        "provider_request_invalid",
        "Provider request does not satisfy the model-interaction Contract.",
        { metadata: { causeName: error instanceof Error ? error.name : null } },
      );
    }
    if (request.continuation !== null) {
      return failed(
        "invalid_request",
        "provider_continuation_unsupported",
        "The configured Ollama API does not support this continuation Contract.",
      );
    }
    if (
      request.interaction.kind === "native_tool_turn" &&
      !this.config.nativeToolInteraction.supported
    ) {
      return failed(
        "unsupported",
        "provider_native_tool_interaction_unsupported",
        "The configured Ollama endpoint and model profile does not declare native Tool interaction.",
      );
    }
    const endpoint = this.endpointUrl(request.interaction);
    const encoded = prepareEncodedRequest(
      this.config,
      request,
      endpoint,
      this.requestBodyTransportLimit,
    );
    if (encoded.kind === "failed") return encoded.result;

    const attempt = createProviderAttemptInterruption(context, this.config.timeoutMs);
    try {
      const interruptedBeforeRequest = providerResultFromInterruption(attempt.cause);
      if (interruptedBeforeRequest !== null) return interruptedBeforeRequest;

      try {
        verifyProviderTransportAccounting({
          accounting: encoded.accounting,
          encodedBody: encoded.body,
          binding: transportBinding(endpoint),
        });
      } catch (error) {
        return failed(
          "transport",
          "provider_transport_binding_mismatch",
          "Provider request transport binding changed after accounting.",
          { metadata: { causeName: error instanceof Error ? error.name : null } },
        );
      }
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encoded.body,
        signal: attempt.signal,
      });
      const interruptedAfterResponse = providerResultFromInterruption(attempt.cause);
      if (interruptedAfterResponse !== null) return interruptedAfterResponse;

      if (!response.ok) {
        const httpClassification = classifyProviderHttpFailure(response.status);
        const diagnostic = await readOllamaHttpErrorDiagnostic(response);
        const interruptedAfterFailureBody = providerResultFromInterruption(attempt.cause);
        if (interruptedAfterFailureBody !== null) return interruptedAfterFailureBody;
        const contextWindowExceeded = response.status === 400 &&
          isOllamaContextWindowExceeded(diagnostic.message);
        const classification = contextWindowExceeded
          ? Object.freeze({
              category: "invalid_request",
              code: "provider_context_window_exceeded",
              message: "Provider rejected the request because the model context window was exceeded.",
            })
          : httpClassification;
        const requestDiagnostic = createProviderHttpRequestDiagnostic({
          operation: request.interaction.kind === "native_tool_turn" ? "chat" : "generate",
          request,
          encodedBody: encoded.body,
        });
        return failed(
          classification.category,
          classification.code,
          formatOllamaHttpFailureMessage(
            classification.message,
            diagnostic,
            requestDiagnostic,
          ),
          {
            ...readProviderHttpFailureMetadata(response),
            metadata: {
              ollamaError: diagnostic.message,
              ollamaErrorTruncated: diagnostic.truncated,
              ...(contextWindowExceeded
                ? {
                    contextWindowTokens: this.config.runtime.contextWindowTokens,
                    maximumOutputTokens: this.config.runtime.maximumOutputTokens,
                  }
                : {}),
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
      return interruptedAfterBody ?? mapOllamaResponse(
        body,
        request,
        this.modelContext.inputPreservation.revision,
      );
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

  private endpointUrl(interaction: ProviderInteraction): string {
    const operation = interaction.kind === "native_tool_turn" ? "chat" : "generate";
    return `${this.config.baseUrl.replace(/\/+$/, "")}/api/${operation}`;
  }
}

function prepareEncodedRequest(
  config: Readonly<OllamaProviderConfig>,
  request: ProviderRequest,
  endpoint: string,
  limit: ProviderTransportLimit,
): { readonly kind: "encoded"; readonly body: string; readonly accounting: ProviderTransportAccounting } |
  { readonly kind: "failed"; readonly result: ProviderCallResult } {
  if (request.modelContext.assessment === null) {
    return Object.freeze({
      kind: "failed",
      result: failed(
        "invalid_request",
        "provider_context_assessment_missing",
        "Provider request has no model-context assessment.",
      ),
    });
  }
  try {
    const body = encodeOllamaRequest(
      config,
      request.instructions,
      request.messages,
      request.interaction,
    );
    const accounting = accountProviderTransport({
      encodedBody: body,
      binding: transportBinding(endpoint),
      limit,
    });
    if (accounting.disposition === "exceeds_limit") {
      return Object.freeze({
        kind: "failed",
        result: failed(
          "transport_limit",
          "provider_transport_request_too_large",
          "Encoded Provider request exceeds the configured request-body transport limit.",
          { metadata: { accounting } },
        ),
      });
    }
    return Object.freeze({ kind: "encoded", body, accounting });
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

function transportBinding(endpoint: string) {
  return Object.freeze({
    method: "POST" as const,
    endpoint,
    contentType: "application/json",
    encoding: "utf-8" as const,
  });
}

function encodeOllamaRequest(
  config: Readonly<OllamaProviderConfig>,
  instructions: ModelInstructions,
  messages: readonly ModelMessage[],
  interaction: ProviderInteraction,
): string {
  if (interaction.kind === "native_tool_turn") {
    return JSON.stringify({
      model: config.model,
      messages: encodeOllamaChatMessages(instructions, messages),
      tools: interaction.callables.map((callable) => ({
        type: "function",
        function: {
          name: callable.name,
          description: callable.description,
          parameters: callable.inputSchema,
        },
      })),
      stream: false,
      truncate: false,
      options: ollamaRuntimeOptions(config),
    });
  }
  return JSON.stringify({
    model: config.model,
    prompt: [
      `system: ${renderInstructions(instructions)}`,
      ...messages.map((message) => `${message.role}: ${renderGenerationText(message)}`),
    ].join("\n\n"),
    stream: false,
    truncate: false,
    options: ollamaRuntimeOptions(config),
    ...ollamaFormatField(interaction),
  });
}

function ollamaRuntimeOptions(
  config: Readonly<OllamaProviderConfig>,
): Readonly<{ num_ctx: number; num_predict: number }> {
  return Object.freeze({
    num_ctx: config.runtime.contextWindowTokens,
    num_predict: config.runtime.maximumOutputTokens,
  });
}

function encodeOllamaChatMessages(
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
        if (result.providerCallRef !== null) {
          throw new TypeError("Ollama Tool results cannot carry a Provider call ref.");
        }
        encoded.push({
          role: "tool",
          tool_name: result.name,
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
            "Ollama assistant history must use at most one text block before Tool calls.",
          );
        }
        textBlockCount += 1;
        text += block.text;
      } else {
        sawCall = true;
        if (block.call.providerCallRef !== null) {
          throw new TypeError("Ollama assistant calls cannot carry a Provider call ref.");
        }
        calls.push({
          type: "function",
          function: {
            index: calls.length,
            name: block.call.name,
            arguments: block.call.input,
          },
        });
      }
    }
    encoded.push({
      role: "assistant",
      content: text,
      ...(calls.length === 0 ? {} : { tool_calls: calls }),
    });
  }
  return encoded;
}

function ollamaFormatField(
  interaction: Exclude<ProviderInteraction, { readonly kind: "native_tool_turn" }>,
): { readonly format?: ReturnType<typeof projectOllamaOutputFormat> } {
  const format = projectOllamaOutputFormat(
    interaction.kind === "structured_generation"
      ? interaction.outputFormat
      : { kind: "text" },
  );
  return format === null ? {} : { format };
}

function mapOllamaResponse(
  value: unknown,
  request: ProviderRequest,
  inputPreservationRevision: string,
): ProviderCallResult {
  return request.interaction.kind === "native_tool_turn"
    ? mapOllamaChatResponse(value, request, inputPreservationRevision)
    : mapOllamaGenerateResponse(value, request, inputPreservationRevision);
}

function mapOllamaChatResponse(
  value: unknown,
  request: ProviderRequest,
  inputPreservationRevision: string,
): ProviderCallResult {
  try {
    if (!isRecord(value) || value.done !== true || !isRecord(value.message)) {
      return failed(
        "response",
        isRecord(value) && value.done === false
          ? "provider_response_incomplete"
          : "provider_response_malformed",
        "Provider response did not contain one complete assistant turn.",
      );
    }
    if (value.message.role !== undefined && value.message.role !== "assistant") {
      return failed(
        "response",
        "provider_response_malformed",
        "Provider response message role was invalid.",
      );
    }
    const content = value.message.content;
    if (typeof content !== "string" || content.length > MAX_RESPONSE_TEXT_LENGTH) {
      return failed(
        "response",
        typeof content === "string"
          ? "provider_response_too_large"
          : "provider_response_malformed",
        "Provider response assistant content was invalid.",
      );
    }
    const transportCalls = value.message.tool_calls ?? [];
    if (!Array.isArray(transportCalls)) {
      return failed(
        "response",
        "provider_response_malformed",
        "Provider response Tool calls were malformed.",
      );
    }

    const responseId = null;
    const turnId = createModelTurnId({
      providerId: PROVIDER_ID,
      requestId: request.requestId,
      responseId,
    });
    const assistantContent: Array<
      | { readonly kind: "text"; readonly text: string }
      | { readonly kind: "model_tool_call"; readonly call: ModelToolCall }
    > = [];
    if (content.length > 0) assistantContent.push({ kind: "text", text: content });
    for (const candidate of transportCalls) {
      const ordinal = assistantContent.length;
      assistantContent.push({
        kind: "model_tool_call",
        call: readOllamaToolCall(candidate, request, turnId, ordinal),
      });
    }
    if (assistantContent.length === 0) {
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
        finish: ollamaFinish(value.done_reason),
        usage: readOllamaUsage(value),
        responseRef: {
          providerId: PROVIDER_ID,
          requestId: request.requestId,
          responseId,
        },
      },
      continuation: null,
      metadata: providerContextMetadata(request, inputPreservationRevision),
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

function readOllamaToolCall(
  value: unknown,
  request: ProviderRequest,
  turnId: string,
  ordinal: number,
): ModelToolCall {
  if (!isRecord(value) || !isRecord(value.function)) {
    throw new TypeError("Ollama Tool call must contain a function.");
  }
  if (value.type !== undefined && value.type !== "function") {
    throw new TypeError("Ollama Tool call type is unsupported.");
  }
  const name = requiredString(value.function.name, "Ollama Tool call name");
  const args = value.function.arguments;
  if (!isRecord(args)) {
    throw new TypeError("Ollama Tool call arguments must be a JSON object.");
  }
  return {
    modelCallRef: createModelCallRef({
      providerRequestId: request.requestId,
      controllerRequestId: request.correlation.controllerRequestId,
      turnId,
      contentBlockOrdinal: ordinal,
      branchId: request.correlation.branchId,
    }),
    providerCallRef: null,
    name,
    input: args as { readonly [key: string]: ModelJsonValue },
    ordinal,
  };
}

function ollamaFinish(value: unknown): ModelTurnFinish {
  if (value === "length") return { kind: "output_limit" };
  if (value === "content_filter") return { kind: "content_filter" };
  if (value === undefined || value === null || value === "stop") {
    return { kind: "normal" };
  }
  return {
    kind: "unknown",
    safeCode: typeof value === "string" && value.trim().length > 0 && value.length <= 128
      ? value.trim()
      : null,
  };
}

function readOllamaUsage(value: Record<string, unknown>) {
  const inputTokens = readCount(value.prompt_eval_count);
  const outputTokens = readCount(value.eval_count);
  return inputTokens === null && outputTokens === null
    ? null
    : {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens === null || outputTokens === null
          ? null
          : inputTokens + outputTokens,
        costUnits: null,
        metadata: {},
      };
}

function mapOllamaGenerateResponse(
  value: unknown,
  request: ProviderRequest,
  inputPreservationRevision: string,
): ProviderCallResult {
  const interaction = request.interaction;
  if (interaction.kind === "native_tool_turn") {
    return failed("response", "provider_response_malformed", "Provider interaction kind changed.");
  }
  if (!isRecord(value) || typeof value.response !== "string") {
    return failed(
      "response",
      "provider_response_malformed",
      "Provider response did not include generated content.",
    );
  }
  if (value.response.length > MAX_RESPONSE_TEXT_LENGTH) {
    return failed(
      "response",
      "provider_response_too_large",
      "Provider response content is too large.",
    );
  }
  if (interaction.kind === "structured_generation") {
    const decoded = decodeStructuredGenerationOutput(value.response);
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
      responseId: null,
      output: decoded.output,
      usage: readOllamaUsage(value),
      continuation: null,
      metadata: providerContextMetadata(request, inputPreservationRevision),
    });
  }
  return succeeded({
    kind: "text_generation",
    responseId: null,
    output: value.response,
    usage: readOllamaUsage(value),
    continuation: null,
    metadata: providerContextMetadata(request, inputPreservationRevision),
  });
}

function providerContextMetadata(
  request: ProviderRequest,
  inputPreservationRevision: string,
) {
  return {
    modelContextAssessmentId: request.modelContext.assessment?.id ?? null,
    modelContextDisposition: request.modelContext.assessment?.disposition ?? null,
    inputPreservationRevision,
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

async function readOllamaHttpErrorDiagnostic(
  response: { readonly json: () => Promise<unknown> },
): Promise<OllamaHttpErrorDiagnostic> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return Object.freeze({ message: null, truncated: false });
  }
  if (!isRecord(body) || typeof body.error !== "string") {
    return Object.freeze({ message: null, truncated: false });
  }
  const bounded = boundProviderHttpDiagnosticText(
    body.error,
    MAX_PROVIDER_HTTP_DIAGNOSTIC_MESSAGE_LENGTH,
  );
  return Object.freeze({
    message: bounded.value,
    truncated: bounded.truncated,
  });
}

function formatOllamaHttpFailureMessage(
  message: string,
  diagnostic: OllamaHttpErrorDiagnostic,
  request: ProviderHttpRequestDiagnostic,
): string {
  const providerDetail = diagnostic.message === null
    ? ""
    : ` Ollama reported: ${diagnostic.message}${diagnostic.truncated ? " [truncated]" : ""}.`;
  return `${message}${providerDetail} Request diagnostic: ` +
    `${renderProviderHttpRequestDiagnostic(request)}.`;
}

function isOllamaContextWindowExceeded(message: string | null): boolean {
  return message !== null &&
    message.toLowerCase().includes("input length exceeds the context length");
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} is required.`);
  }
  return value.trim();
}

function snapshotConfig(input: OllamaProviderConfig): Readonly<OllamaProviderConfig> {
  const baseUrl = requiredString(input.baseUrl, "Ollama base URL");
  const model = requiredString(input.model, "Ollama model");
  const url = new URL(baseUrl);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new TypeError("Ollama base URL must be an HTTP URL without credentials.");
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
    throw new TypeError("Ollama timeout must be a positive integer.");
  }
  if (
    !isRecord(input.runtime) ||
    !Number.isSafeInteger(input.runtime.contextWindowTokens) ||
    input.runtime.contextWindowTokens <= 0 ||
    !Number.isSafeInteger(input.runtime.maximumOutputTokens) ||
    input.runtime.maximumOutputTokens <= 0 ||
    input.runtime.maximumOutputTokens >= input.runtime.contextWindowTokens
  ) {
    throw new TypeError("Ollama runtime limits are invalid.");
  }
  if (
    !isRecord(input.nativeToolInteraction) ||
    typeof input.nativeToolInteraction.supported !== "boolean"
  ) {
    throw new TypeError("Ollama native Tool interaction configuration is invalid.");
  }
  if (
    !isRecord(input.requestBodyTransportLimit) ||
    !Number.isSafeInteger(input.requestBodyTransportLimit.maximumBytes) ||
    input.requestBodyTransportLimit.maximumBytes <= 0 ||
    (input.requestBodyTransportLimit.source !== "provider_reported" &&
      input.requestBodyTransportLimit.source !== "host_configured") ||
    typeof input.requestBodyTransportLimit.revision !== "string" ||
    input.requestBodyTransportLimit.revision.trim().length === 0
  ) {
    throw new TypeError("Ollama request-body transport limit is invalid.");
  }
  return Object.freeze({
    baseUrl,
    model,
    timeoutMs: input.timeoutMs,
    runtime: Object.freeze({
      contextWindowTokens: input.runtime.contextWindowTokens,
      maximumOutputTokens: input.runtime.maximumOutputTokens,
    }),
    nativeToolInteraction: Object.freeze({
      supported: input.nativeToolInteraction.supported,
    }),
    requestBodyTransportLimit: Object.freeze({ ...input.requestBodyTransportLimit }),
  });
}
