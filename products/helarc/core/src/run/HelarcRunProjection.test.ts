import {
  createHostRunProjection,
  type HostRunProjection,
} from "@agent-anything/host/projection";
import { describe, expect, it } from "vitest";
import type { HelarcActivityItem, HelarcProductResult } from "../composition/index.js";
import {
  createHelarcProductRunProjection,
  createHelarcRunProjection,
  reduceHelarcProductRunProjection,
  reduceHelarcRunProjection,
  type HelarcProductRunProjection,
} from "./HelarcRunProjection.js";

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
    for (const status of ["blocked", "failed", "cancelled"] as const) {
      expect(createHelarcRunProjection({
        host: hostProjection({ status }),
        product: activeProduct,
      }).display).toEqual({ status, terminal: true, statusSource: "host" });
    }
  });

  it("lets product rejection or failure refine host completion", () => {
    for (const status of ["rejected", "blocked", "failed"] as const) {
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
        }],
      },
    }),
    ...overrides,
  };
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
  return {
    status,
    runResult: {
      runId: "harness-run-1",
      status: status === "cancelled" ? "cancelled" : "succeeded",
      code: status === "cancelled" ? "runtime_cancelled" : null,
      startedAt: "2026-07-17T00:00:00.000Z",
      completedAt: "2026-07-17T00:00:01.000Z",
    },
    output: {
      taskId: "task-1",
      workspace: { primaryId: "workspace-1", additionalIds: [] },
      agentSummary: "Done",
      runtimeStatus: status === "cancelled" ? "cancelled" : "succeeded",
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
