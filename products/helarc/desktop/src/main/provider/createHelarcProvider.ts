import type { Provider } from "@agent-anything/model-interaction";
import { OllamaProvider } from "@agent-anything/provider-integrations/ollama";
import { OpenAICompatibleProvider } from "@agent-anything/provider-integrations/openai-compatible";
import type { HelarcProviderConfig } from "./resolveHelarcProviderConfig.js";

export function createHelarcProvider(config: HelarcProviderConfig): Provider {
  const inputLimit = Object.freeze({
    maximumBytes: 512 * 1_024,
    source: "host_configured" as const,
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
      inputLimit,
    });
  }
  return new OpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: config.timeoutMs,
    nativeToolInteraction: { supported: true },
    inputLimit,
  });
}
