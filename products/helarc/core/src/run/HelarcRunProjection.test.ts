import {
  createHostRunProjection,
  type HostRunProjection,
} from "@agent-anything/host/projection";
import type {
  RunTreeNodeResourceSnapshot,
  RunTreeResourceSnapshot,
} from "@agent-anything/agent-runtime/runner";
import { describe, expect, it } from "vitest";
import type { HelarcActivityItem, HelarcProductResult } from "../composition/index.js";
import {
  createHelarcProductRunProjection as createProductRunProjection,
  createHelarcRunProjection,
  reduceHelarcProductRunProjection,
  reduceHelarcRunProjection,
  type HelarcProductRunProjection,
} from "./HelarcRunProjection.js";

function createHelarcProductRunProjection(runId: string) {
  return createProductRunProjection(runId, qualification());
}

describe("Helarc product Run projection", () => {
  it("reduces ordered activity and terminal result updates", () => {
    let projection = createHelarcProductRunProjection("run-1");
    projection = applyProduct(projection, {
      kind: "activity_appended",
      runId: "run-1",
      sequence: 1,
      activity: activity(1),
    });
    projection = applyProduct(projection, {
      kind: "result_settled",
      runId: "run-1",
      sequence: 2,
      result: productResult("completed"),
    });

    expect(projection).toMatchObject({
      runId: "run-1",
      sequence: 2,
      phase: { kind: "none" },
      result: { status: "completed" },
    });
    expect(projection.activity).toHaveLength(1);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.result?.output.safeErrors)).toBe(true);
  });

  it("retains only the safe Model Continuation lifecycle projection", () => {
    const projection = applyProduct(createHelarcProductRunProjection("run-1"), {
      kind: "continuation_changed",
      runId: "run-1",
      sequence: 1,
      continuation: {
        branchId: "run-1:main",
        requestId: "request-1",
        kind: "reused",
        reason: null,
        occurredAt: "2026-08-17T00:00:00.000Z",
      },
    });

    expect(projection.continuation).toEqual({
      branchId: "run-1:main",
      requestId: "request-1",
      kind: "reused",
      reason: null,
      occurredAt: "2026-08-17T00:00:00.000Z",
    });
    expect(Object.isFrozen(projection.continuation)).toBe(true);
  });

  it("rejects stale, cross-Run, duplicate activity, and post-terminal updates", () => {
    const initial = createHelarcProductRunProjection("run-1");
    const active = applyProduct(initial, {
      kind: "activity_appended",
      runId: "run-1",
      sequence: 1,
      activity: activity(1),
    });
    expect(reduceHelarcProductRunProjection(active, {
      kind: "activity_appended",
      runId: "run-1",
      sequence: 1,
      activity: activity(2),
    })).toMatchObject({ status: "rejected", code: "stale_sequence", projection: active });
    expect(reduceHelarcProductRunProjection(active, {
      kind: "activity_appended",
      runId: "run-other",
      sequence: 2,
      activity: activity(2),
    })).toMatchObject({ status: "rejected", code: "run_identity_mismatch" });
    expect(reduceHelarcProductRunProjection(active, {
      kind: "activity_appended",
      runId: "run-1",
      sequence: 2,
      activity: activity(1),
    })).toMatchObject({ status: "rejected", code: "invalid_update" });

    const settled = applyProduct(active, {
      kind: "result_settled",
      runId: "run-1",
      sequence: 2,
      result: productResult("completed"),
    });
    expect(reduceHelarcProductRunProjection(settled, {
      kind: "activity_appended",
      runId: "run-1",
      sequence: 3,
      activity: activity(2),
    })).toMatchObject({ status: "rejected", code: "invalid_transition", projection: settled });
  });
});

describe("Helarc unified Run projection", () => {
  it("derives active approval state from the generic Host interaction", () => {
    expect(createHelarcRunProjection({
      host: hostProjection({
        status: "waiting",
        pendingInteractions: [pendingApproval()],
      }),
      product: createHelarcProductRunProjection("run-1"),
    }).display).toMatchObject({ status: "waiting_for_approval", statusSource: "host" });
  });

  it("gives non-success host terminals precedence over product state", () => {
    const activeProduct = createHelarcProductRunProjection("run-1");
    for (const status of ["failed", "cancelled"] as const) {
      expect(createHelarcRunProjection({
        host: hostProjection({ status }),
        product: activeProduct,
      }).display).toEqual({ status, terminal: true, statusSource: "host" });
    }
  });

  it("lets product rejection or failure refine host completion", () => {
    for (const status of ["rejected", "failed"] as const) {
      const product = applyProduct(createHelarcProductRunProjection("run-1"), {
        kind: "result_settled",
        runId: "run-1",
        sequence: 1,
        result: productResult(status),
      });
      expect(createHelarcRunProjection({
        host: hostProjection({ status: "completed" }),
        product,
      }).display).toEqual({ status, terminal: true, statusSource: "product" });
    }
  });

  it("derives completed from host completion and absent or completed product result", () => {
    const host = hostProjection({ status: "completed" });
    expect(createHelarcRunProjection({
      host,
      product: createHelarcProductRunProjection("run-1"),
    }).display).toEqual({ status: "completed", terminal: true, statusSource: "host" });
  });

  it("applies newer source sequences and rejects stale or cross-Run races", () => {
    const initial = createHelarcRunProjection({
      host: hostProjection({ sequence: 1 }),
      product: createHelarcProductRunProjection("run-1"),
    });
    expect(initial).toMatchObject({
      productRunId: "run-1",
      harnessRunId: "harness-run-1",
    });
    const hostApplied = reduceHelarcRunProjection(initial, {
      kind: "host",
      projection: hostProjection({ sequence: 2, status: "cancelling" }),
    });
    expect(hostApplied).toMatchObject({
      status: "applied",
      projection: { display: { status: "cancelling" } },
    });
    if (hostApplied.status !== "applied") throw new Error("Expected applied projection.");

    expect(reduceHelarcRunProjection(hostApplied.projection, {
      kind: "host",
      projection: hostProjection({ sequence: 1 }),
    })).toMatchObject({ status: "rejected", code: "stale_host_sequence" });
    expect(reduceHelarcRunProjection(hostApplied.projection, {
      kind: "host",
      projection: hostProjection({ runId: "harness-run-other", sequence: 3 }),
    })).toMatchObject({ status: "rejected", code: "run_identity_mismatch" });
    expect(reduceHelarcRunProjection(hostApplied.projection, {
      kind: "product",
      projection: { ...createHelarcProductRunProjection("run-other"), sequence: 1 },
    })).toMatchObject({ status: "rejected", code: "run_identity_mismatch" });
  });

  it("rebuilds an identical display from current immutable source snapshots", () => {
    const host = hostProjection({ sequence: 3, status: "running" });
    const product = createHelarcProductRunProjection("run-1");
    const first = createHelarcRunProjection({ host, product });
    const rebuilt = createHelarcRunProjection({ host, product });
    expect(rebuilt).toEqual(first);
    expect(rebuilt.host).toBe(host);
    expect(rebuilt.product).toBe(product);
  });
});

function applyProduct(
  current: HelarcProductRunProjection,
  update: Parameters<typeof reduceHelarcProductRunProjection>[1],
): HelarcProductRunProjection {
  const result = reduceHelarcProductRunProjection(current, update);
  if (result.status !== "applied") throw new Error(`Projection rejected: ${result.code}`);
  return result.projection;
}

function hostProjection(
  overrides: Partial<HostRunProjection> = {},
): HostRunProjection {
  return {
    ...createHostRunProjection({
      sessionId: "session-1",
      taskId: "task-1",
      runId: "harness-run-1",
      startedAt: "2026-07-17T00:00:00.000Z",
      enforcement: "disabled",
      runTree: {
        rootRunId: "harness-run-1",
        revision: 0,
        deadlineAt: "2026-07-17T00:01:00.000Z",
        limits: {
          maxDescendantDepth: 2,
          maxTotalDescendantRuns: 4,
          maxActiveDescendantRuns: 2,
        },
        totalDescendantRuns: 0,
        activeDescendantRuns: 0,
        resources: runTreeResources(),
        approvals: {
          limits: {
            maxTotalRequests: 8,
            maxRequestsPerOperationFingerprint: 2,
            maxConsecutiveDeclines: 3,
            maxConsecutiveReviewerFailures: 3,
            maxActiveReviews: 2,
          },
          revision: 0,
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
          latest: null,
        },
        settlement: {
          complete: false,
          unsettledDescendantRuns: 0,
          pendingResultTransfers: 0,
          failedResultTransfers: 0,
          unknownResultTransfers: 0,
        },
        nodes: [{
          runId: "harness-run-1",
          parentRunId: null,
          relationId: null,
          parentRunActionId: null,
          depth: 0,
          status: "initializing",
          resultCode: null,
          startedAt: "2026-07-17T00:00:00.000Z",
          completedAt: null,
          resources: runTreeNodeResources(),
          authorityRevision: "authority-root-1",
          cancellation: null,
          resultTransfer: "not_required",
        }],
      },
    }),
    ...overrides,
  };
}

function runTreeResources(): RunTreeResourceSnapshot {
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
    controllerTurns: resource(),
    actions: resource(),
    modelInputTokens: resource(),
    modelOutputTokens: resource(),
    costUnits: resource(),
    contextBytes: resource(),
    resultBytes: resource(),
  };
}

function runTreeNodeResources(): RunTreeNodeResourceSnapshot {
  const amounts = Object.freeze({
    controllerTurns: 100,
    actions: 100,
    modelInputTokens: 100,
    modelOutputTokens: 100,
    costUnits: 100,
    contextBytes: 100,
    resultBytes: 100,
  });
  const measurement = () => Object.freeze({
    status: "measured" as const,
    value: 0,
  });
  return Object.freeze({
    runId: "harness-run-1",
    parentRunId: null,
    allocation: amounts,
    remaining: amounts,
    usage: Object.freeze({
      controllerTurns: measurement(),
      actions: measurement(),
      modelInputTokens: measurement(),
      modelOutputTokens: measurement(),
      costUnits: measurement(),
      contextBytes: measurement(),
      resultBytes: measurement(),
    }),
    settled: false,
    revision: 0,
  });
}

function activity(sequence: number): HelarcActivityItem {
  return {
    id: `event-${sequence}`,
    sequence,
    source: {
      runId: "harness-run-1",
      eventSequence: sequence,
      lineage: {
        kind: "root",
        root: { id: "harness-run-1" },
        depth: 0,
      },
    },
    timestamp: "2026-07-17T00:00:00.000Z",
    kind: "controller.started",
    title: "Controller started",
    detail: null,
    metadata: {},
  };
}

function productResult(status: HelarcProductResult["status"]): HelarcProductResult {
  const runtimeStatus = status === "cancelled"
    ? "cancelled" as const
    : status === "failed"
      ? "failed" as const
      : "succeeded" as const;
  return {
    status,
    qualification: qualification(),
    runResult: {
      runId: "harness-run-1",
      status: runtimeStatus,
      code: runtimeStatus === "cancelled"
        ? "runtime_cancelled"
        : runtimeStatus === "failed"
          ? "provider_request_failed"
          : "completion_accepted",
      startedAt: "2026-07-17T00:00:00.000Z",
      completedAt: "2026-07-17T00:00:01.000Z",
    },
    output: {
      taskId: "task-1",
      workspace: { primaryId: "workspace-1", additionalIds: [] },
      agentSummary: "Done",
      runtimeStatus,
      enforcement: { selected: "disabled", status: "not_exercised", code: null },
      safeErrors: [],
    },
    runActions: [],
    effects: [],
    actions: [],
    composites: [],
    children: [],
    interactions: [],
    verification: {
      status: "not_required",
      snapshotRevision: 1,
      counts: [],
      activeChecks: 0,
      gateStatus: null,
      waiting: false,
      recoveryNeeded: false,
      safeReasons: [],
      updatedAt: "2026-07-17T00:00:01.000Z",
    },
    uncertainty: [],
    residualRisk: [],
    incompleteWork: [],
    nextActions: [],
    artifactRefs: [],
  };
}

function qualification() {
  return Object.freeze({
    providerKind: "openai-compatible",
    modelId: "test-model",
    modelIdentityStrength: "unknown" as const,
    status: "experimental" as const,
    policy: "allow_experimental" as const,
    experimentalUseSelected: true,
    scopes: Object.freeze([Object.freeze({
      scope: "agent_loop" as const,
      applicability: "absent" as const,
      outcome: null,
      decidedAt: null,
      limitations: Object.freeze([]),
    })]),
    reasons: Object.freeze(["scope_absent:agent_loop"]),
    toolGuidance: Object.freeze({
      releaseId: "test-guidance",
      releaseRevision: `sha256:${"0".repeat(64)}`,
      profileRevision: "test-profile.v1",
    }),
  });
}

function pendingApproval(): HostRunProjection["pendingInteractions"][number] {
  return {
    request: {
      id: "approval-request-1",
      protocol: { owner: "permission", kind: "approval", revision: "1" },
      requestVersion: 1,
      subject: { owner: "canonical-action", kind: "action", id: "action-1", revision: "1" },
    },
    presentation: {},
    disclosureClass: "internal",
    expiresAt: null,
    blockingScope: "run",
    phase: "pending",
  };
}
