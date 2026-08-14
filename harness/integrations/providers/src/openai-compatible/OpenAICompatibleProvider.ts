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
}

export class OpenAICompatibleProvider implements Provider {
  readonly descriptor: ProviderDescriptor = {
    id: "openai-compatible.chat-completions",
    name: "OpenAI-compatible Chat Completions",
    capabilities: {
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: false,
    },
    requestRetryScheduler: { kind: "harness" },
    metadata: {},
  };

  constructor(
    config: OpenAICompatibleProviderConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch as FetchLike,
  ) {
    this.config = snapshotConfig(config);
  }

  private readonly config: Readonly<OpenAICompatibleProviderConfig>;

  async send(
    request: ProviderRequest,
    context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    const attempt = createProviderAttemptInterruption(context, this.config.timeoutMs);

    try {
      const interruptedBeforeRequest = providerResultFromInterruption(attempt.cause);
      if (interruptedBeforeRequest !== null) {
        return interruptedBeforeRequest;
      }

      const response = await this.fetchImpl(this.endpointUrl(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          stream: false,
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
      return interruptedAfterBody ?? mapChatCompletionResponse(body);
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

function mapChatCompletionResponse(value: unknown): ProviderCallResult {
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
    output: content,
    usage: readUsage(value.usage),
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

function readUsage(value: unknown): ProviderResponse["usage"] {
  if (!isRecord(value)) {
    return null;
  }

  return {
    inputTokens: readNumber(value.prompt_tokens),
    outputTokens: readNumber(value.completion_tokens),
    totalTokens: readNumber(value.total_tokens),
    metadata: {},
  };
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
