import type { Provider } from "@agent-anything/providers";
import { OllamaProvider } from "./OllamaProvider.js";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider.js";
import type { HelarcProviderConfig } from "./resolveHelarcProviderConfig.js";

export function createHelarcProvider(config: HelarcProviderConfig): Provider {
  return config.providerKind === "ollama"
    ? new OllamaProvider(config)
    : new OpenAICompatibleProvider(config);
}
