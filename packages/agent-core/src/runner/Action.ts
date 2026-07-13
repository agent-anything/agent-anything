export type ActionKind = "internal" | "tool" | "permission_request";

export interface ActionCandidate {
  readonly kind: ActionKind;
  readonly name: string;
  readonly input: unknown;
  readonly modelItemId: string;
}

export interface ActionProvenance {
  readonly modelItemId: string;
  readonly controllerIteration: number;
}

export interface Action {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly kind: ActionKind;
  readonly name: string;
  readonly input: unknown;
  readonly provenance: ActionProvenance;
}
