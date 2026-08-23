import {
  createProviderAttemptInterruption,
  providerResultFromInterruption,
  type Provider,
  type ProviderCallResult,
  type ProviderDescriptor,
  type ProviderFailure,
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
      renderFraming: (sections, outputFormat) => JSON.stringify({
        protocol: "ollama-generate",
        model: this.config.model,
        roles: sections.map((section) => section.role),
        separators: Math.max(0, sections.length - 1),
        stream: false,
        ...ollamaFormatField(outputFormat),
      }),
    });
    this.descriptor = Object.freeze({
      id: "ollama.generate",
      name: "Ollama Generate",
      capabilities: Object.freeze({
        supportsToolPlanning: true,
        supportsStructuredOutput: true,
        supportsStreaming: false,
        modelInput: this.inputAccounting.capability,
        continuation: Object.freeze({ supported: false as const }),
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

      const response = await this.fetchImpl(this.endpointUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          prompt: renderPrompt(request),
          stream: false,
          ...ollamaFormatField(request.outputFormat),
        }),
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
      return interruptedAfterBody ?? mapOllamaGenerateResponse(body);
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
      outputFormat: request.outputFormat,
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

function renderPrompt(request: ProviderRequest): string {
  return request.messages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n\n");
}

function ollamaFormatField(
  outputFormat: ProviderRequest["outputFormat"],
): { readonly format?: ReturnType<typeof projectOllamaOutputFormat> } {
  const format = projectOllamaOutputFormat(outputFormat);
  return format === null ? {} : { format };
}

function mapOllamaGenerateResponse(value: unknown): ProviderCallResult {
  if (!isRecord(value) || typeof value.response !== "string") {
    return failed("response", "provider_response_malformed", "Provider response did not include generated content.");
  }

  if (value.response.length > 64_000) {
    return failed("response", "provider_response_too_large", "Provider response content is too large.");
  }

  return succeeded({
    responseId: null,
    output: value.response,
    usage: {
      inputTokens: readNumber(value.prompt_eval_count),
      outputTokens: readNumber(value.eval_count),
      totalTokens: readTotalTokens(value),
      metadata: {},
    },
    continuation: null,
    metadata: {},
  });
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
