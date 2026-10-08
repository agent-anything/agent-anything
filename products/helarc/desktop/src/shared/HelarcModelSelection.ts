// Safe IPC values are owned by Desktop, not imports of executable workspace Contracts.
export type ModelThinkingSelection = { readonly mode: "default" | "disabled" }
  | { readonly mode: "enabled"; readonly effort?: string };
export interface ModelThinkingCapability {
  readonly status: "known" | "unknown";
  readonly values: readonly (boolean | string)[];
  readonly defaultValue: boolean | string | null;
  readonly source: "endpoint" | "declaration" | "unknown";
}
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
export interface HelarcProviderModelSettings {
  readonly service: "generic" | "deepseek" | "ollama";
  readonly thinking: ModelThinkingSelection;
  readonly maximumOutputTokens: number;
}

export interface HelarcModelSelection {
  readonly profileId: string;
  readonly profileRevision: string;
  readonly model: string;
  readonly thinking: ModelThinkingSelection;
}
export interface HelarcModelDiscoveryQuery {
  readonly profileId: string;
  readonly profileRevision: string;
  readonly model: string;
  readonly refresh: boolean;
}
export type HelarcModelDiscoveryResult =
  | { readonly ok: true; readonly profileId: string; readonly profileRevision: string; readonly catalog: ModelDiscovery }
  | { readonly ok: false; readonly error: string };
