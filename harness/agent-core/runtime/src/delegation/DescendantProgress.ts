import type { DelegationRequestRef } from "@agent-anything/agent-core/delegation";
import type { RunRef } from "@agent-anything/agent-core/run";
import type { DescendantRunRelationRef } from "@agent-anything/agent-core/run-tree";
import type { RunSuspension } from "../run/index.js";
import { deepFreeze, strictRecord, token } from "./DelegationContract.js";

export type DescendantAdmittedControl = "steer" | "resume" | "cancel";

export interface DescendantProgress {
  readonly relation: DescendantRunRelationRef;
  readonly request: DelegationRequestRef;
  readonly childRun: RunRef;
  readonly childRunRevision: number;
  readonly suspension: RunSuspension;
  readonly admittedControls: readonly DescendantAdmittedControl[];
  readonly observedAt: string;
}

export function createDescendantProgress(input: DescendantProgress): DescendantProgress {
  strictRecord(input, "DescendantProgress", [
    "relation",
    "request",
    "childRun",
    "childRunRevision",
    "suspension",
    "admittedControls",
    "observedAt",
  ]);
  if (!Number.isSafeInteger(input.childRunRevision) || input.childRunRevision < 0) {
    throw new TypeError("DescendantProgress.childRunRevision must be a non-negative safe integer.");
  }
  const controls = [...input.admittedControls];
  if (
    controls.length === 0 ||
    new Set(controls).size !== controls.length ||
    controls.some((control) => control !== "steer" && control !== "resume" && control !== "cancel")
  ) {
    throw new TypeError("DescendantProgress.admittedControls must be unique supported controls.");
  }
  if (
    input.suspension.ref.run.id !== input.childRun.id ||
    input.suspension.runRevision !== input.childRunRevision
  ) {
    throw new TypeError("DescendantProgress suspension must describe the exact Child Run revision.");
  }
  if (!Number.isFinite(Date.parse(input.observedAt))) {
    throw new TypeError("DescendantProgress.observedAt must be a valid date-time string.");
  }
  return deepFreeze({
    relation: { id: token(input.relation.id, "DescendantProgress.relation.id") },
    request: input.request,
    childRun: { id: token(input.childRun.id, "DescendantProgress.childRun.id") },
    childRunRevision: input.childRunRevision,
    suspension: input.suspension,
    admittedControls: controls,
    observedAt: input.observedAt,
  });
}
