import { deriveActiveRunStatus, type PendingRunSubject, type RunStatus } from "../run/index.js";

export function deriveRunStatusAfterPendingChange(
  status: RunStatus,
  pending: readonly PendingRunSubject[],
  progressableBranchIds: readonly string[] = [],
): RunStatus {
  if (status !== "initializing" && status !== "running" && status !== "waiting") return status;
  return deriveActiveRunStatus({ pending, progressableBranchIds });
}
