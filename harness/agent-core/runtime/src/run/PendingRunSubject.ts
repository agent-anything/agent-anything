import type { PendingInteractionRef } from "@agent-anything/interaction/coordination";

interface PendingRunSubjectBase {
  readonly branchId: string;
  readonly required: boolean;
  readonly openedInRunRevision: number;
}

export type PendingRunSubject =
  | (PendingRunSubjectBase & {
      readonly kind: "interaction";
      readonly interaction: PendingInteractionRef;
    })
  | (PendingRunSubjectBase & {
      readonly kind: "composite";
      readonly compositeId: string;
      readonly nodeId: string;
    })
  | (PendingRunSubjectBase & {
      readonly kind: "descendant_run";
      readonly relationId: string;
      readonly childRunId: string;
    });

export interface PendingRunSubjectProjection {
  readonly kind: PendingRunSubject["kind"];
  readonly branchId: string;
  readonly required: boolean;
  readonly owner: string;
  readonly subjectId: string;
  readonly revision: string;
}

export function projectPendingRunSubject(
  pending: PendingRunSubject,
): PendingRunSubjectProjection {
  if (pending.kind === "interaction") {
    return Object.freeze({
      kind: pending.kind,
      branchId: pending.branchId,
      required: pending.required,
      owner: pending.interaction.request.protocol.owner,
      subjectId: pending.interaction.request.id,
      revision: String(pending.interaction.request.requestVersion),
    });
  }
  if (pending.kind === "composite") {
    return Object.freeze({
      kind: pending.kind,
      branchId: pending.branchId,
      required: pending.required,
      owner: "operation-composition",
      subjectId: `${pending.compositeId}:${pending.nodeId}`,
      revision: String(pending.openedInRunRevision),
    });
  }
  return Object.freeze({
    kind: pending.kind,
    branchId: pending.branchId,
    required: pending.required,
    owner: "agent-runtime",
    subjectId: pending.childRunId,
    revision: String(pending.openedInRunRevision),
  });
}

export function deriveActiveRunStatus(input: {
  readonly pending: readonly PendingRunSubject[];
  readonly progressableBranchIds: readonly string[];
}): "running" | "waiting" {
  const progressable = new Set(input.progressableBranchIds);
  return input.pending.some((item) => item.required) &&
      !input.pending.some((item) => progressable.has(item.branchId))
    ? "waiting"
    : "running";
}
