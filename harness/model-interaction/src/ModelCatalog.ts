import type { ModelThinkingCapability } from "./ModelThinking.js";

export interface DiscoveredModel {
  readonly id: string;
  readonly name: string;
  readonly artifact: string | null;
  readonly contextWindowTokens: number | null;
  readonly maximumOutputTokens: number | null;
  readonly thinking: ModelThinkingCapability;
}

export interface ModelDiscovery {
  readonly models: readonly DiscoveredModel[];
  readonly observedAt: string;
  readonly source: string;
  readonly declarationRevision: string | null;
}
