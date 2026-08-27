import {
  createProviderAttemptInterruption,
  providerResultFromInterruption,
  type Provider,
  type ProviderCallResult,
  type ProviderDescriptor,
  type ProviderFailure,
  type ProviderInteraction,
  type ModelMessage,
  type ProviderRequest,
  type ProviderResponse,
} from "@agent-anything/model-interaction";
import {
  createUtf8ModelInputAccounting,
  type ProviderModelInputAccounting,
} from "@agent-anything/model-interaction/input";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import {
  readProviderHttpFailureMetadata,
} from "../http/ProviderHttpFailureMetadata.js";
import type { FetchLike } from "../http/ProviderHttpTransport.js";

export interface OpenAICompatibleProviderConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
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
      providerId: "openai-compatible.chat-completions",
      model: this.config.model,
      maximumInputBytes: this.config.inputLimit.maximumBytes,
      limitSource: this.config.inputLimit.source,
      estimator: { id: "openai-compatible.utf8-content", revision: "1" },
      framing: { id: "openai-compatible.chat-completions-framing", revision: "1" },
      renderRequest: (messages, interaction) =>
        encodeOpenAIRequest(this.config.model, messages, interaction),
    });
    this.descriptor = Object.freeze({
      id: "openai-compatible.chat-completions",
      name: "OpenAI-compatible Chat Completions",
      capabilities: Object.freeze({
        nativeToolInteraction: Object.freeze({ supported: false as const }),
        structuredGeneration: Object.freeze({ supported: true as const }),
        streaming: Object.freeze({ supported: false as const }),
        modelInput: this.inputAccounting.capability,
        continuation: Object.freeze({ supported: false as const }),
        compaction: Object.freeze({ supported: false as const }),
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
    if (request.interaction.kind === "native_tool_turn") {
      return failed(
        "unsupported",
        "provider_native_tool_interaction_unsupported",
        "OpenAI-compatible native Tool interaction is not enabled by this adapter revision.",
      );
    }
    const verificationFailure = verifyProviderRequest(this.inputAccounting, request);
    if (verificationFailure !== null) {
      return verificationFailure;
    }
    const attempt = createProviderAttemptInterruption(context, this.config.timeoutMs);

    try {
      const interruptedBeforeRequest = providerResultFromInterruption(attempt.cause);
      if (interruptedBeforeRequest !== null) {
        return interruptedBeforeRequest;
      }

      const encodedRequest = encodeOpenAIRequest(
        this.config.model,
        request.messages,
        request.interaction,
      );
      this.inputAccounting.verifyEncoded({
        providerId: this.inputAccounting.providerId,
        model: this.inputAccounting.model,
        messages: request.messages,
        interaction: request.interaction,
        composition: request.composition,
        encodedRequest,
      });
      const response = await this.fetchImpl(this.endpointUrl(), {
        method: "POST",
        headers: this.headers(),
        body: encodedRequest,
        signal: attempt.signal,
      });
      const interruptedAfterResponse = providerResultFromInterruption(attempt.cause);
      if (interruptedAfterResponse !== null) {
        return interruptedAfterResponse;
      }

      if (!response.ok) {
        return failed(
          "http",
          "provider_http_error",
          `Provider request failed with HTTP ${response.status}.`,
          readProviderHttpFailureMetadata(response),
        );
      }

      const body = await response.json();
      const interruptedAfterBody = providerResultFromInterruption(attempt.cause);
      return interruptedAfterBody ?? mapChatCompletionResponse(body, request.interaction);
    } catch (error) {
      const interruption = providerResultFromInterruption(attempt.cause);
      if (interruption !== null) {
        return interruption;
      }

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
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (this.config.apiKey.length > 0) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }

    return headers;
  }
}

function verifyProviderRequest(
  accounting: ProviderModelInputAccounting,
  request: ProviderRequest,
): ProviderCallResult | null {
  try {
    accounting.verify({
      providerId: accounting.providerId,
      model: accounting.model,
      messages: request.messages,
      interaction: request.interaction,
      composition: request.composition,
    });
    return null;
  } catch {
    return failed(
      "invalid_request",
      "provider_input_accounting_invalid",
      "Provider request does not match its verified model-input composition.",
    );
  }
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
  interaction: Exclude<ProviderInteraction, { readonly kind: "native_tool_turn" }>,
): ProviderCallResult {
  if (!isRecord(value)) {
    return failed("response", "provider_response_malformed", "Provider response was malformed.");
  }

  const content = readContent(value);
  if (content === null) {
    return failed("response", "provider_response_malformed", "Provider response did not include message content.");
  }

  if (content.length > 64_000) {
    return failed("response", "provider_response_too_large", "Provider response content is too large.");
  }

  return succeeded({
    kind: interaction.kind,
    responseId: typeof value.id === "string" ? value.id : null,
    output: content,
    usage: readUsage(value.usage),
    continuation: null,
    metadata: {},
  });
}

function readContent(value: Record<string, unknown>): string | null {
  const choices = value.choices;
  if (!Array.isArray(choices)) {
    return null;
  }

  const first = choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    return null;
  }

  return typeof first.message.content === "string" ? first.message.content : null;
}

function readUsage(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }

  return {
    inputTokens: readNumber(value.prompt_tokens) ?? null,
    outputTokens: readNumber(value.completion_tokens) ?? null,
    totalTokens: readNumber(value.total_tokens) ?? null,
    metadata: {},
  };
}

function encodeOpenAIRequest(
  model: string,
  messages: readonly ModelMessage[],
  interaction: ProviderInteraction,
): string {
  if (interaction.kind === "native_tool_turn") {
    throw new TypeError("This adapter revision cannot encode native Tool interaction.");
  }
  return JSON.stringify({
    model,
    messages: messages.map((message) => ({
      role: message.role,
      content: renderTextContent(message),
    })),
    stream: false,
    ...(interaction.kind === "structured_generation"
      ? { response_format: openAIResponseFormat(interaction.outputFormat) }
      : {}),
  });
}

function renderTextContent(message: ModelMessage): string {
  if (message.role === "tool") {
    throw new TypeError("Text and structured generation accept text-only Model Messages.");
  }
  return message.content.map((block) => {
    if (block.kind !== "text") {
      throw new TypeError("Text and structured generation accept text-only Model Messages.");
    }
    return block.text;
  }).join("");
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function succeeded(response: ProviderResponse): ProviderCallResult {
  return { kind: "succeeded", response };
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
  return {
    kind: "failed",
    failure,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotConfig(
  input: OpenAICompatibleProviderConfig,
): Readonly<OpenAICompatibleProviderConfig> {
  return Object.freeze({
    baseUrl: validatedBaseUrl(input.baseUrl),
    apiKey: requiredString(input.apiKey, "OpenAI-compatible API key", true),
    model: requiredString(input.model, "OpenAI-compatible model"),
    timeoutMs: positiveTimeout(input.timeoutMs),
    inputLimit: snapshotInputLimit(input.inputLimit, "OpenAI-compatible"),
  });
}

function snapshotInputLimit(
  input: OpenAICompatibleProviderConfig["inputLimit"],
  owner: string,
): OpenAICompatibleProviderConfig["inputLimit"] {
  if (
    input === null ||
    typeof input !== "object" ||
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

function requiredString(value: string, field: string, allowEmpty = false): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) throw new TypeError(`${field} is required.`);
  return normalized;
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("OpenAI-compatible timeout must be a positive integer.");
  }
  return value;
}
