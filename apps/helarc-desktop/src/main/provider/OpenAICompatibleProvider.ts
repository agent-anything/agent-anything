import type { Provider, ProviderDescriptor, ProviderRequest, ProviderResponse } from "@agent-anything/providers";
import type { HelarcProviderConfig } from "./resolveHelarcProviderConfig.js";

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export class OpenAICompatibleProvider implements Provider {
  readonly descriptor: ProviderDescriptor = {
    id: "helarc-openai-compatible",
    name: "Helarc OpenAI-compatible Provider",
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
        headers: this.headers(),
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return failed("provider_http_error", `Provider request failed with HTTP ${response.status}.`, {
          status: response.status,
        });
      }

      return mapChatCompletionResponse(await response.json());
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

function mapChatCompletionResponse(value: unknown): ProviderResponse {
  if (!isRecord(value)) {
    return failed("provider_response_malformed", "Provider response was malformed.");
  }

  const content = readContent(value);
  if (content === null) {
    return failed("provider_response_malformed", "Provider response did not include message content.");
  }

  if (content.length > 64_000) {
    return failed("provider_response_too_large", "Provider response content is too large.");
  }

  return {
    status: "succeeded",
    output: content,
    usage: readUsage(value.usage),
    error: null,
    metadata: {},
  };
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
