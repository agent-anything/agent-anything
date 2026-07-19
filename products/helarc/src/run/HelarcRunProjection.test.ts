import { createHostRunProjection, type HostRunProjection } from "@agent-anything/host";
import { describe, expect, it } from "vitest";
import type { HelarcActivityItem, HelarcProductPhase, HelarcProductResult } from "../composition/index.js";
import {
  createHelarcProductRunProjection,
  createHelarcRunProjection,
  reduceHelarcProductRunProjection,
  reduceHelarcRunProjection,
  type HelarcProductRunProjection,
} from "./HelarcRunProjection.js";

describe("Helarc product Run projection", () => {
  it("reduces ordered phase, activity, and terminal result updates", () => {
    let projection = createHelarcProductRunProjection("run-1");
    projection = applyProduct(projection, {
      kind: "phase_changed",
      runId: "run-1",
      sequence: 1,
      phase: waitingPhase(),
    });
    projection = applyProduct(projection, {
      kind: "activity_appended",
      runId: "run-1",
      sequence: 2,
      activity: activity(1),
    });
    projection = applyProduct(projection, {
      kind: "result_settled",
      runId: "run-1",
      sequence: 3,
      result: productResult("completed"),
    });

    expect(projection).toMatchObject({
      runId: "run-1",
      sequence: 3,
      phase: { kind: "none" },
      result: { status: "completed" },
    });
    expect(projection.activity).toHaveLength(1);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.result?.output.safeErrors)).toBe(true);
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
      kind: "phase_changed",
      runId: "run-1",
      sequence: 1,
      phase: { kind: "none" },
    })).toMatchObject({ status: "rejected", code: "stale_sequence", projection: active });
    expect(reduceHelarcProductRunProjection(active, {
      kind: "phase_changed",
      runId: "run-other",
      sequence: 2,
      phase: { kind: "none" },
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
      kind: "phase_changed",
      runId: "run-1",
      sequence: 3,
      phase: waitingPhase(),
    })).toMatchObject({ status: "rejected", code: "invalid_transition", projection: settled });
  });
});

describe("Helarc unified Run projection", () => {
  it("derives active approval and Patch phases without mutable display state", () => {
    const platform = hostProjection({ status: "running" });
    let product = createHelarcProductRunProjection("run-1");
    product = applyProduct(product, {
      kind: "phase_changed",
      runId: "run-1",
      sequence: 1,
      phase: waitingPhase(),
    });
    expect(createHelarcRunProjection({ platform, product }).display).toEqual({
      status: "waiting_for_patch_review",
      terminal: false,
      statusSource: "product",
    });

    product = applyProduct(product, {
      kind: "phase_changed",
      runId: "run-1",
      sequence: 2,
      phase: waitingPhase("submitted_for_resolution"),
    });
    expect(createHelarcRunProjection({ platform, product }).display.status).toBe("applying_patch");
    expect(createHelarcRunProjection({
      platform: hostProjection({ status: "waiting_for_approval", approval: {} as never }),
      product,
    }).display).toMatchObject({ status: "waiting_for_approval", statusSource: "platform" });
  });

  it("gives non-success platform terminals precedence over product state", () => {
    const activeProduct = applyProduct(createHelarcProductRunProjection("run-1"), {
      kind: "phase_changed",
      runId: "run-1",
      sequence: 1,
      phase: waitingPhase(),
    });
    for (const status of ["blocked", "failed", "cancelled"] as const) {
      expect(createHelarcRunProjection({
        platform: hostProjection({ status }),
        product: activeProduct,
      }).display).toEqual({ status, terminal: true, statusSource: "platform" });
    }
  });

  it("lets product rejection or failure refine platform completion", () => {
    for (const status of ["rejected", "blocked", "failed"] as const) {
      const product = applyProduct(createHelarcProductRunProjection("run-1"), {
        kind: "result_settled",
        runId: "run-1",
        sequence: 1,
        result: productResult(status),
      });
      expect(createHelarcRunProjection({
        platform: hostProjection({ status: "completed" }),
        product,
      }).display).toEqual({ status, terminal: true, statusSource: "product" });
    }
  });

  it("derives completed from platform completion and absent or completed product result", () => {
    const platform = hostProjection({ status: "completed" });
    expect(createHelarcRunProjection({
      platform,
      product: createHelarcProductRunProjection("run-1"),
    }).display).toEqual({ status: "completed", terminal: true, statusSource: "platform" });
  });

  it("applies newer source sequences and rejects stale or cross-Run races", () => {
    const initial = createHelarcRunProjection({
      platform: hostProjection({ sequence: 1 }),
      product: createHelarcProductRunProjection("run-1"),
    });
    const platformApplied = reduceHelarcRunProjection(initial, {
      kind: "platform",
      projection: hostProjection({ sequence: 2, status: "cancelling" }),
    });
    expect(platformApplied).toMatchObject({
      status: "applied",
      projection: { display: { status: "cancelling" } },
    });
    if (platformApplied.status !== "applied") throw new Error("Expected applied projection.");

    expect(reduceHelarcRunProjection(platformApplied.projection, {
      kind: "platform",
      projection: hostProjection({ sequence: 1 }),
    })).toMatchObject({ status: "rejected", code: "stale_platform_sequence" });
    expect(reduceHelarcRunProjection(platformApplied.projection, {
      kind: "product",
      projection: { ...createHelarcProductRunProjection("run-other"), sequence: 1 },
    })).toMatchObject({ status: "rejected", code: "run_identity_mismatch" });
  });

  it("rebuilds an identical display from current immutable source snapshots", () => {
    const platform = hostProjection({ sequence: 3, status: "running" });
    const product = applyProduct(createHelarcProductRunProjection("run-1"), {
      kind: "phase_changed",
      runId: "run-1",
      sequence: 1,
      phase: waitingPhase(),
    });
    const first = createHelarcRunProjection({ platform, product });
    const rebuilt = createHelarcRunProjection({ platform, product });
    expect(rebuilt).toEqual(first);
    expect(rebuilt.platform).toBe(platform);
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
      runId: "run-1",
      startedAt: "2026-07-17T00:00:00.000Z",
      enforcement: "disabled",
    }),
    ...overrides,
  };
}

function waitingPhase(
  phase: "reviewing" | "submitted_for_resolution" = "reviewing",
): HelarcProductPhase {
  return {
    kind: "waiting_for_patch_review",
    review: {
      runId: "run-1",
      proposalId: "proposal-1",
      reviewId: "review-1",
      pendingVersion: 1,
      rootName: "root",
      workspaceId: "workspace-1",
      path: "src/file.ts",
      operation: "update",
      summary: "Update file",
      rationale: "Apply requested change.",
      originalContent: "before\n",
      proposedContent: "after\n",
      originalContentBytes: 7,
      proposedContentBytes: 6,
      phase,
    },
  };
}

function activity(sequence: number): HelarcActivityItem {
  return {
    id: `event-${sequence}`,
    sequence,
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
    output: {
      taskId: "task-1",
      workspaceId: "workspace-1",
      agentSummary: "Done",
      runtimeStatus: status === "cancelled" ? "cancelled" : "succeeded",
      patchStatus: status === "rejected" ? "rejected" : null,
      appliedPath: null,
      enforcement: { selected: "disabled", status: "not_exercised", code: null },
      safeErrors: [],
    },
  };
}
