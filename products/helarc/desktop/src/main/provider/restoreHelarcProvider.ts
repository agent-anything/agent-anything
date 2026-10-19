import type { HelarcExecutionAdmission } from "../execution-storage/HelarcExecutionAdmission.js";
import { retainHelarcProviderBinding } from "../execution-storage/HelarcExecutionAdmission.js";
import { canonicalEncode } from "@agent-anything/canonical-action/subject";
import type { ProviderObserver } from "@agent-anything/model-interaction/transport";
import { createHelarcProvider } from "./createHelarcProvider.js";
import type { HelarcProviderConfig } from "./resolveHelarcProviderConfig.js";
import { snapshotHelarcProviderModelSettings } from "@agent-anything/helarc/configuration";

/** Rebind the saved effective selection, not today's profile defaults or discovery. */
export function restoreHelarcProvider(saved: Pick<HelarcExecutionAdmission, "providerProfile" | "providerBinding">,
  apiKey: string, observer?: ProviderObserver) {
  const profile = saved.providerProfile;
  const settings = snapshotHelarcProviderModelSettings(profile.modelSettings, profile.providerKind);
  const metadata = saved.providerBinding.descriptor.metadata;
  const selectionFacts = metadata?.modelSelection as HelarcProviderConfig["selectionFacts"];
  const generation = metadata?.generationConfiguration as {modelArtifact?: string | null} | undefined;
  const provider = createHelarcProvider({providerKind: profile.providerKind, baseUrl: profile.baseUrl,
    model: profile.model, timeoutMs: profile.timeoutMs, ollamaRuntime: profile.ollamaRuntime, apiKey,
    modelSettings: {...settings, thinking: selectionFacts?.effective ?? settings.thinking},
    modelArtifact: generation?.modelArtifact ?? null, ...(selectionFacts ? {selectionFacts} : {})}, observer);
  const expected = canonicalEncode("helarc.provider-recovery.v1", saved.providerBinding);
  const actual = canonicalEncode("helarc.provider-recovery.v1", retainHelarcProviderBinding(provider));
  if (expected.length !== actual.length || expected.some((value, index) => actual[index] !== value)) {
    throw new Error("The original Provider implementation or effective configuration is unavailable.");
  }
  return provider;
}
