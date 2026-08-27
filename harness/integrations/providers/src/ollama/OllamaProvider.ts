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
import type { FetchLike } from "../http/ProviderHttpTransport.js";
import { readProviderHttpFailureMetadata } from "../http/ProviderHttpFailureMetadata.js";
import { projectOllamaOutputFormat } from "./OllamaJsonSchemaDialect.js";

export interface OllamaProviderConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly inputLimit: {
    readonly maximumBytes: number;
    readonly source: "provider_reported" | "host_configured";
  };
}

export class OllamaProvider implements Provider {
  readonly descriptor: ProviderDescriptor;
  readonly inputAccounting: ProviderModelInputAccounting;

  constructor(
    config: OllamaProviderConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch as FetchLike,
  ) {
    this.config = snapshotConfig(config);
    this.inputAccounting = createUtf8ModelInputAccounting({
      providerId: "ollama.generate",
      model: this.config.model,
      maximumInputBytes: this.config.inputLimit.maximumBytes,
      limitSource: this.config.inputLimit.source,
      estimator: { id: "ollama.generate.utf8-content", revision: "1" },
      framing: { id: "ollama.generate-framing", revision: "2" },
      renderRequest: (messages, interaction) =>
        encodeOllamaGenerateRequest(this.config.model, messages, interaction),
    });
    this.descriptor = Object.freeze({
      id: "ollama.generate",
      name: "Ollama Generate",
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

  private readonly config: Readonly<OllamaProviderConfig>;

  async send(
    request: ProviderRequest,
    context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    if (request.continuation !== null) {
      return failed(
        "invalid_request",
        "provider_continuation_unsupported",
        "The selected Ollama Generate endpoint does not support this continuation Contract.",
      );
    }
    if (request.interaction.kind === "native_tool_turn") {
      return failed(
        "unsupported",
        "provider_native_tool_interaction_unsupported",
        "Ollama native Tool interaction is not enabled by this adapter revision.",
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

      const encodedRequest = encodeOllamaGenerateRequest(
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
        headers: { "content-type": "application/json" },
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
      return interruptedAfterBody ?? mapOllamaGenerateResponse(body, request.interaction);
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
    return `${this.config.baseUrl.replace(/\/+$/, "")}/api/generate`;
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

function mapOllamaGenerateResponse(
  value: unknown,
  interaction: Exclude<ProviderInteraction, { readonly kind: "native_tool_turn" }>,
): ProviderCallResult {
  if (!isRecord(value) || typeof value.response !== "string") {
    return failed("response", "provider_response_malformed", "Provider response did not include generated content.");
  }

  if (value.response.length > 64_000) {
    return failed("response", "provider_response_too_large", "Provider response content is too large.");
  }

  return succeeded({
    kind: interaction.kind,
    responseId: null,
    output: value.response,
    usage: {
      inputTokens: readNumber(value.prompt_eval_count) ?? null,
      outputTokens: readNumber(value.eval_count) ?? null,
      totalTokens: readTotalTokens(value) ?? null,
      metadata: {},
    },
    continuation: null,
    metadata: {},
  });
}

function encodeOllamaGenerateRequest(
  model: string,
  messages: readonly ModelMessage[],
  interaction: ProviderInteraction,
): string {
  if (interaction.kind === "native_tool_turn") {
    throw new TypeError("This adapter revision cannot encode native Tool interaction.");
  }
  return JSON.stringify({
    model,
    prompt: messages
      .map((message) => `${message.role}: ${renderTextContent(message)}`)
      .join("\n\n"),
    stream: false,
    ...ollamaFormatField(interaction),
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

function readTotalTokens(value: Record<string, unknown>): number | undefined {
  const inputTokens = readNumber(value.prompt_eval_count);
  const outputTokens = readNumber(value.eval_count);
  return inputTokens === undefined || outputTokens === undefined
    ? undefined
    : inputTokens + outputTokens;
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

function snapshotConfig(input: OllamaProviderConfig): Readonly<OllamaProviderConfig> {
  const baseUrl = input.baseUrl.trim();
  const model = input.model.trim();
  if (baseUrl.length === 0 || model.length === 0) {
    throw new TypeError("Ollama base URL and model are required.");
  }
  const url = new URL(baseUrl);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new TypeError("Ollama base URL must be an HTTP URL without credentials.");
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
    throw new TypeError("Ollama timeout must be a positive integer.");
  }
  if (
    input.inputLimit === null ||
    typeof input.inputLimit !== "object" ||
    !Number.isSafeInteger(input.inputLimit.maximumBytes) ||
    input.inputLimit.maximumBytes <= 0 ||
    (input.inputLimit.source !== "provider_reported" &&
      input.inputLimit.source !== "host_configured")
  ) {
    throw new TypeError("Ollama input limit is invalid.");
  }
  return Object.freeze({
    baseUrl,
    model,
    timeoutMs: input.timeoutMs,
    inputLimit: Object.freeze({ ...input.inputLimit }),
  });
}
