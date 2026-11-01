import type {HelarcProviderModelSettings} from "./HelarcModelSelection.js";

export interface HelarcContextObservationTarget {
  readonly profileId:string;
  readonly providerKind:"ollama"|"openai-compatible";
  readonly baseUrl:string;
  readonly model:string;
  readonly modelSettings:HelarcProviderModelSettings;
  readonly contextWindowTokens:number|null;
  readonly artifact:string|null;
}
export interface HelarcContextCapabilityObservation {
  readonly id:string;
  readonly revision:string;
  readonly target:HelarcContextObservationTarget;
  readonly duty:"generation"|"assessment";
  readonly method:{readonly id:string;readonly revision:string}|null;
  readonly protocol:string|null;
  readonly conclusion:"supported"|"limited"|"unknown"|"conflicting";
  readonly dimensions:readonly ("format_and_references"|"source_support"|"coverage"|"exact_values_and_unknowns"|"revision_and_relationships"|"misses_and_false_positives")[];
  readonly conditions:string;
  readonly finding:string;
  readonly source:string;
  readonly limitations:string;
  readonly observedAt:string;
}
export interface HelarcContextSettings {
  readonly autoRepresentation:boolean;
  readonly observations:readonly HelarcContextCapabilityObservation[];
}
export interface HelarcContextSettingsSnapshot {
  readonly revision:string;
  readonly settings:HelarcContextSettings;
}
