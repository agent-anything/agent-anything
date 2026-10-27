import type { Provider } from "@agent-anything/model-interaction";
import type { HelarcProviderProfile } from "../configuration/HelarcProviderProfile.js";

export class HelarcProviderCompatibilityError extends Error {
  readonly code = "model_native_tool_interaction_unsupported";
  constructor() {
    super("The configured Provider does not support the native Tool interaction required by Helarc.");
    this.name = "HelarcProviderCompatibilityError";
  }
}

export function assertHelarcProviderCompatibility(provider: Provider, profile: HelarcProviderProfile): void {
  const kind = provider.descriptor.id === "openai-compatible.chat-completions" ? "openai-compatible"
    : provider.descriptor.id === "ollama.api" ? "ollama" : null;
  if (provider.modelContext.target.providerId !== provider.descriptor.id ||
      provider.modelContext.target.model !== profile.model ||
      (kind !== null && kind !== profile.providerKind)) {
    throw new TypeError("Helarc Provider profile, descriptor, and model-target identities differ.");
  }
  if (!provider.descriptor.capabilities.nativeToolInteraction.supported) throw new HelarcProviderCompatibilityError();
}
