import type { ISODateTimeString, Metadata } from "../primitives/index.js";

export type ActionKind = "internal" | "tool" | "permission_request";

export type ActionRejectedCode =
  | "action_invalid"
  | "action_unsupported"
  | "tool_not_found";

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

export interface ObservationBase {
  readonly id: string;
  readonly runId: string;
  readonly actionId: string;
  readonly createdAt: ISODateTimeString;
  readonly metadata: Metadata;
}
