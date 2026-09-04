import type { Provider } from "@agent-anything/model-interaction";
import { OllamaProvider } from "@agent-anything/provider-integrations/ollama";
import { OpenAICompatibleProvider } from "@agent-anything/provider-integrations/openai-compatible";
import type { HelarcProviderConfig } from "./resolveHelarcProviderConfig.js";

export function createHelarcProvider(config: HelarcProviderConfig): Provider {
  const requestBodyTransportLimit = Object.freeze({
    maximumBytes: 512 * 1_024,
    source: "host_configured" as const,
    revision: "helarc.desktop.provider-request-body-limit.v1",
  });
  if (config.providerKind === "ollama") {
    if (config.ollamaRuntime === null) {
      throw new TypeError("Ollama Provider configuration requires runtime limits.");
    }
    return new OllamaProvider({
      baseUrl: config.baseUrl,
      model: config.model,
      timeoutMs: config.timeoutMs,
      runtime: config.ollamaRuntime,
      nativeToolInteraction: { supported: true },
      requestBodyTransportLimit,
    });
  }
  return new OpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maximumOutputTokens: 4_096,
    nativeToolInteraction: { supported: true },
    requestBodyTransportLimit,
  });
}
