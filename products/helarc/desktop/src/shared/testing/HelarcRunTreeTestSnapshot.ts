import type { HelarcRunTreeSnapshot } from "../HelarcDesktopApi.js";

export function createHelarcRunTreeTestSnapshot(input: {
  readonly runId: string;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly status?: HelarcRunTreeSnapshot["nodes"][number]["status"];
  readonly revision?: number;
}) {
  const resource = () => ({
    capacity: 100,
    consumed: 0,
    reserved: 0,
    remaining: 100,
    released: 0,
    measurementStatus: "measured" as const,
    enforcement: "hard" as const,
  });
  return {
    rootRunId: input.runId,
    revision: input.revision ?? 0,
    deadlineAt: input.deadlineAt,
    limits: {
      maxDescendantDepth: 2,
      maxTotalDescendantRuns: 4,
      maxActiveDescendantRuns: 2,
    },
    totalDescendantRuns: 0,
    activeDescendantRuns: 0,
    resources: {
      controllerTurns: resource(),
      actions: resource(),
      modelInputTokens: resource(),
      modelOutputTokens: resource(),
      costUnits: resource(),
      contextBytes: resource(),
      resultBytes: resource(),
    },
    approvals: {
      totalRequests: 0,
      activeReviews: 0,
      settledRequests: 0,
      uniqueOperationFingerprints: 0,
      maxEquivalentOperationRequests: 0,
      consecutiveDeclines: 0,
      consecutiveReviewerFailures: 0,
      exhaustedCode: null,
    },
    cancellation: {
      totalRequests: 0,
      treeRequested: false,
      subtreeRequests: 0,
      latestScope: null,
      latestOrigin: null,
      latestReasonCode: null,
      latestRequestedAt: null,
    },
    settlement: {
      complete: false,
      unsettledDescendantRuns: 0,
      pendingResultTransfers: 0,
      failedResultTransfers: 0,
      unknownResultTransfers: 0,
    },
    nodes: [{
      runId: input.runId,
      parentRunId: null,
      relationId: null,
      parentRunActionId: null,
      depth: 0,
      status: input.status ?? "running",
      resultCode: null,
      startedAt: input.startedAt,
      completedAt: null,
      resourcesSettled: false,
      resultTransfer: "not_required",
      cancellationScope: null,
    }],
  } satisfies HelarcRunTreeSnapshot;
}
