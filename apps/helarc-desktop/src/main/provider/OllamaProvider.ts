import type { Provider, ProviderDescriptor, ProviderRequest, ProviderResponse } from "@agent-anything/providers";
import type { FetchLike } from "./OpenAICompatibleProvider.js";
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
    metadata: {},
  };

  constructor(
    private readonly config: HelarcProviderConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch as FetchLike,
  ) {}

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpointUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          prompt: renderPrompt(request),
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return failed("provider_http_error", `Provider request failed with HTTP ${response.status}.`, {
          status: response.status,
        });
      }

      return mapOllamaGenerateResponse(await response.json());
    } catch (error) {
      if (isAbortError(error)) {
        return failed("provider_timeout", "Provider request timed out.");
      }

      return failed("provider_request_failed", "Provider request failed.");
    } finally {
      clearTimeout(timeout);
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

function mapOllamaGenerateResponse(value: unknown): ProviderResponse {
  if (!isRecord(value) || typeof value.response !== "string") {
    return failed("provider_response_malformed", "Provider response did not include generated content.");
  }

  if (value.response.length > 64_000) {
    return failed("provider_response_too_large", "Provider response content is too large.");
  }

  return {
    status: "succeeded",
    output: value.response,
    usage: {
      inputTokens: readNumber(value.prompt_eval_count),
      outputTokens: readNumber(value.eval_count),
      totalTokens: readTotalTokens(value),
      metadata: {},
    },
    error: null,
    metadata: {},
  };
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

function failed(code: string, message: string, metadata: Record<string, unknown> = {}): ProviderResponse {
  return {
    status: "failed",
    output: null,
    usage: null,
    error: { code, message, metadata },
    metadata: {},
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
