import type { Provider } from "@agent-anything/model-interaction";
import { OllamaProvider } from "@agent-anything/provider-integrations/ollama";
import { OpenAICompatibleProvider } from "@agent-anything/provider-integrations/openai-compatible";
import type { HelarcProviderConfig } from "./resolveHelarcProviderConfig.js";

export function createHelarcProvider(config: HelarcProviderConfig): Provider {
  return config.providerKind === "ollama"
    ? new OllamaProvider({
        baseUrl: config.baseUrl,
        model: config.model,
        timeoutMs: config.timeoutMs,
      })
    : new OpenAICompatibleProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        timeoutMs: config.timeoutMs,
      });
}
