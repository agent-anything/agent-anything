import {
  createProviderAttemptInterruption,
  providerResultFromInterruption,
  type Provider,
  type ProviderCallResult,
  type ProviderDescriptor,
  type ProviderFailure,
  type ProviderRequest,
  type ProviderResponse,
} from "@agent-anything/providers";
import type { InvocationInterruptionContext } from "@agent-anything/shared";
import type { FetchLike } from "./OpenAICompatibleProvider.js";
import { readProviderHttpFailureMetadata } from "./ProviderHttpFailureMetadata.js";
import type { HelarcProviderConfig } from "./resolveHelarcProviderConfig.js";

export class OllamaProvider implements Provider {
  readonly descriptor: ProviderDescriptor = {
    id: "helarc-ollama",
    name: "Helarc Ollama Provider",
    capabilities: {
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: false,
    },
    requestRetryScheduler: { kind: "platform" },
    metadata: {},
  };

  constructor(
    private readonly config: HelarcProviderConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch as FetchLike,
  ) {}

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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          prompt: renderPrompt(request),
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

function renderPrompt(request: ProviderRequest): string {
  return request.messages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n\n");
}

function mapOllamaGenerateResponse(value: unknown): ProviderCallResult {
  if (!isRecord(value) || typeof value.response !== "string") {
    return failed("response", "provider_response_malformed", "Provider response did not include generated content.");
  }

  if (value.response.length > 64_000) {
    return failed("response", "provider_response_too_large", "Provider response content is too large.");
  }

  return succeeded({
    output: value.response,
    usage: {
      inputTokens: readNumber(value.prompt_eval_count),
      outputTokens: readNumber(value.eval_count),
      totalTokens: readTotalTokens(value),
      metadata: {},
    },
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
