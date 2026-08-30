import type { RunTreeExecutionSnapshot } from "@agent-anything/agent-runtime/runner";

export function createTestRootRunTreeSnapshot(
  runId: string,
  startedAt: string,
): RunTreeExecutionSnapshot {
  const resource = () => Object.freeze({
    capacity: 100, measuredConsumed: 0, chargedUnknown: 0,
    activeReserved: 0, available: 100, cumulativeReleased: 0,
    measurementStatus: "measured" as const, enforcement: "hard" as const,
  });
  const amounts = Object.freeze({
    controllerTurns: 100, actions: 100, modelInputTokens: 100,
    modelOutputTokens: 100, costUnits: 100, contextBytes: 100, resultBytes: 100,
  });
  const usage = Object.freeze({
    controllerTurns: { status: "measured" as const, value: 0 },
    actions: { status: "measured" as const, value: 0 },
    modelInputTokens: { status: "measured" as const, value: 0 },
    modelOutputTokens: { status: "measured" as const, value: 0 },
    costUnits: { status: "measured" as const, value: 0 },
    contextBytes: { status: "measured" as const, value: 0 },
    resultBytes: { status: "measured" as const, value: 0 },
  });
  return Object.freeze({
    rootRunId: runId,
    revision: 0,
    deadlineAt: "2026-08-13T00:01:00.000Z",
    limits: Object.freeze({
      maxDescendantDepth: 2, maxTotalDescendantRuns: 4,
      maxActiveDescendantRuns: 2,
    }),
    totalDescendantRuns: 0,
    activeDescendantRuns: 0,
    resources: Object.freeze({
      controllerTurns: resource(), actions: resource(), modelInputTokens: resource(),
      modelOutputTokens: resource(), costUnits: resource(), contextBytes: resource(),
      resultBytes: resource(),
    }),
    approvals: Object.freeze({
      limits: Object.freeze({
        maxTotalRequests: 4, maxRequestsPerOperationFingerprint: 2,
        maxConsecutiveDeclines: 2, maxConsecutiveReviewerFailures: 2,
        maxActiveReviews: 2,
      }),
      revision: 0, totalRequests: 0, activeReviews: 0, settledRequests: 0,
      uniqueOperationFingerprints: 0, maxEquivalentOperationRequests: 0,
      consecutiveDeclines: 0, consecutiveReviewerFailures: 0, exhaustedCode: null,
    }),
    cancellation: Object.freeze({
      totalRequests: 0, treeRequested: false, subtreeRequests: 0, latest: null,
    }),
    settlement: Object.freeze({
      complete: false, unsettledDescendantRuns: 0, pendingResultTransfers: 0,
      failedResultTransfers: 0, unknownResultTransfers: 0,
    }),
    nodes: Object.freeze([Object.freeze({
      runId, parentRunId: null, relationId: null, relationKind: null,
      parentRunActionId: null,
      depth: 0, status: "initializing" as const, resultCode: null,
      startedAt, completedAt: null,
      resources: Object.freeze({
        runId, parentRunId: null, requestedAllocation: amounts,
        hardGrant: amounts, hardAvailable: amounts,
        observationalThresholds: Object.freeze(Object.fromEntries(
          Object.keys(amounts).map((key) => [key, 0]),
        )) as typeof amounts,
        delegationCeiling: amounts,
        usage, settled: false, revision: 0,
      }),
      authorityRevision: `${runId}:authority:active:0`,
      cancellation: null,
      resultTransfer: "not_required" as const,
    })]),
  });
}
