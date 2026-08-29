import { describe, expect, it } from "vitest";
import type { RunLineage } from "@agent-anything/agent-core/run-tree";
import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import { createRunCancellationController } from "../run/index.js";
import { RunTreeExecution } from "./RunTreeExecution.js";

const STARTED_AT = "2026-08-23T00:00:00.000Z";
const DEADLINE_AT = "2026-08-23T00:01:00.000Z";

describe("RunTreeExecution", () => {
  it("accounts total and active reservations across the complete tree", () => {
    const tree = createTree({
      maxTotalDescendantRuns: 2,
      maxActiveDescendantRuns: 1,
      maxDescendantDepth: 2,
    });
    const first = reserve(tree, tree.rootLineage, "run-root", "run-child-1", 1);
    expect(first.status).toBe("accepted");

    expect(reserve(tree, tree.rootLineage, "run-root", "run-child-active", 2))
      .toEqual({ status: "rejected", code: "descendant_run_active_limit_exceeded", treeRevision: 1 });
    tree.settleRun("run-child-1", "succeeded", null, "2026-08-23T00:00:10.000Z");

    const second = reserve(tree, tree.rootLineage, "run-root", "run-child-2", 3);
    expect(second.status).toBe("accepted");
    tree.settleRun("run-child-2", "failed", "runtime_execution_failed", "2026-08-23T00:00:20.000Z");

    expect(reserve(tree, tree.rootLineage, "run-root", "run-child-total", 4))
      .toEqual({ status: "rejected", code: "descendant_run_total_limit_exceeded", treeRevision: 4 });
    expect(tree.getSnapshot()).toMatchObject({
      totalDescendantRuns: 2,
      activeDescendantRuns: 0,
    });
  });

  it("derives depth and rejects a descendant beyond the configured maximum", () => {
    const tree = createTree({
      maxTotalDescendantRuns: 3,
      maxActiveDescendantRuns: 3,
      maxDescendantDepth: 1,
    });
    const child = reserve(tree, tree.rootLineage, "run-root", "run-child", 1);
    expect(child.status).toBe("accepted");
    if (child.status !== "accepted") return;

    expect(reserve(tree, child.lineage, "run-child", "run-grandchild", 1))
      .toEqual({ status: "rejected", code: "descendant_run_depth_limit_exceeded", treeRevision: 1 });
  });

  it("inherits the earliest tree, parent, and local deadline", () => {
    const tree = createTree({
      maxTotalDescendantRuns: 1,
      maxActiveDescendantRuns: 1,
      maxDescendantDepth: 1,
    });
    const child = tree.reserveDescendant({
      relationId: "relation-1",
      createChildRunId: () => "run-child",
      parentRunId: "run-root",
      parentLineage: tree.rootLineage,
      parentRunAction: action("run-root", 1),
      parentDeadlineAt: "2026-08-23T00:00:40.000Z",
      childLocalDeadlineAt: "2026-08-23T00:00:50.000Z",
      resourceAllocation: resourceAmounts(100),
      authorityRevision: "run-child-authority-v1",
    });
    expect(child).toMatchObject({
      status: "accepted",
      deadlineAt: "2026-08-23T00:00:40.000Z",
    });
  });

  it("rejects starts after cancellation or the effective deadline", () => {
    const cancelledTree = createTree({
      maxTotalDescendantRuns: 1,
      maxActiveDescendantRuns: 1,
      maxDescendantDepth: 1,
    });
    const rootCancellation = cancellation("run-root");
    cancelledTree.registerCancellation("run-root", rootCancellation);
    rootCancellation.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });
    expect(reserve(
      cancelledTree,
      cancelledTree.rootLineage,
      "run-root",
      "run-cancelled-child",
      1,
    )).toEqual({
      status: "rejected",
      code: "descendant_run_start_cancelled",
      treeRevision: 0,
    });

    const expiredTree = createTree({
      maxTotalDescendantRuns: 1,
      maxActiveDescendantRuns: 1,
      maxDescendantDepth: 1,
    }, DEADLINE_AT);
    expect(reserve(
      expiredTree,
      expiredTree.rootLineage,
      "run-root",
      "run-expired-child",
      1,
    )).toEqual({
      status: "rejected",
      code: "descendant_run_deadline_exceeded",
      treeRevision: 0,
    });
  });

  it("does not refund total reservation after startup failure", () => {
    const tree = createTree({
      maxTotalDescendantRuns: 1,
      maxActiveDescendantRuns: 1,
      maxDescendantDepth: 1,
    });
    expect(reserve(tree, tree.rootLineage, "run-root", "run-child", 1).status)
      .toBe("accepted");
    tree.failStart("run-child", "2026-08-23T00:00:01.000Z");

    expect(tree.getSnapshot()).toMatchObject({
      totalDescendantRuns: 1,
      activeDescendantRuns: 0,
    });
    expect(reserve(tree, tree.rootLineage, "run-root", "run-other", 2))
      .toEqual({ status: "rejected", code: "descendant_run_total_limit_exceeded", treeRevision: 2 });
  });

  it("commits terminal lifecycle only from settled RunResult facts", () => {
    const tree = createTree({
      maxTotalDescendantRuns: 1,
      maxActiveDescendantRuns: 1,
      maxDescendantDepth: 1,
    });
    expect(reserve(tree, tree.rootLineage, "run-root", "run-child", 1).status)
      .toBe("accepted");

    tree.updateLifecycle("run-child", "failed");
    expect(tree.getSnapshot().nodes.at(-1)).toMatchObject({
      status: "initializing",
      resultCode: null,
      completedAt: null,
    });

    tree.settleRun(
      "run-child",
      "failed",
      "runtime_execution_failed",
      "2026-08-23T00:00:01.000Z",
    );
    expect(tree.getSnapshot()).toMatchObject({ activeDescendantRuns: 0 });
    expect(tree.getSnapshot().nodes.at(-1)).toMatchObject({
      status: "failed",
      resultCode: "runtime_execution_failed",
      completedAt: "2026-08-23T00:00:01.000Z",
    });
  });

  it("prevents root settlement while a descendant remains active", () => {
    const tree = createTree({
      maxTotalDescendantRuns: 1,
      maxActiveDescendantRuns: 1,
      maxDescendantDepth: 1,
    });
    expect(reserve(tree, tree.rootLineage, "run-root", "run-child", 1).status)
      .toBe("accepted");

    expect(() => tree.settleRun(
      "run-root",
      "succeeded",
      null,
      "2026-08-23T00:00:01.000Z",
    )).toThrow("root Run cannot settle while descendants remain active");
  });

  it("propagates root cancellation to every active descendant", () => {
    const tree = createTree({
      maxTotalDescendantRuns: 2,
      maxActiveDescendantRuns: 2,
      maxDescendantDepth: 2,
    });
    const rootCancellation = cancellation("run-root");
    tree.registerCancellation("run-root", rootCancellation);
    const child = reserve(tree, tree.rootLineage, "run-root", "run-child", 1);
    expect(child.status).toBe("accepted");
    if (child.status !== "accepted") return;
    const childCancellation = cancellation("run-child");
    tree.registerCancellation("run-child", childCancellation);
    const grandchild = reserve(tree, child.lineage, "run-child", "run-grandchild", 1);
    expect(grandchild.status).toBe("accepted");
    if (grandchild.status !== "accepted") return;
    const grandchildCancellation = cancellation("run-grandchild");
    tree.registerCancellation("run-grandchild", grandchildCancellation);

    rootCancellation.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });

    expect(childCancellation.context.request).toMatchObject({
      origin: "parent_run",
      parentRunId: "run-root",
    });
    expect(grandchildCancellation.context.request).toMatchObject({
      origin: "parent_run",
      parentRunId: "run-child",
    });
  });

  it("invalidates an Action authority basis when authority, resources, or cancellation change", () => {
    const tree = createTree({
      maxTotalDescendantRuns: 1,
      maxActiveDescendantRuns: 1,
      maxDescendantDepth: 1,
    });
    const rootCancellation = cancellation("run-root");
    tree.registerCancellation("run-root", rootCancellation);

    const authorityBasis = tree.captureAuthorityBasis("run-root");
    expect(tree.isAuthorityBasisCurrent("run-root", authorityBasis)).toBe(true);
    tree.advanceAuthorityRevision("run-root");
    expect(tree.isAuthorityBasisCurrent("run-root", authorityBasis)).toBe(false);

    const resourceBasis = tree.captureAuthorityBasis("run-root");
    tree.recordResources("run-root", {
      controllerTurns: { status: "measured", value: 1 },
    });
    expect(tree.isAuthorityBasisCurrent("run-root", resourceBasis)).toBe(false);

    const cancellationBasis = tree.captureAuthorityBasis("run-root");
    rootCancellation.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });
    expect(tree.isAuthorityBasisCurrent("run-root", cancellationBasis)).toBe(false);
  });

  it("materializes root resource projection without a standalone tree notification", () => {
    const tree = createTree({
      maxTotalDescendantRuns: 1,
      maxActiveDescendantRuns: 1,
      maxDescendantDepth: 1,
    });
    const revisions: number[] = [];
    tree.subscribe((snapshot) => revisions.push(snapshot.revision));
    const before = tree.getSnapshot().revision;

    tree.recordResources("run-root", {
      controllerTurns: { status: "measured", value: 1 },
    });

    expect(revisions).toEqual([before]);
    expect(tree.captureAuthorityBasis("run-root").resourceRevision).toBe(1);

    tree.updateLifecycle("run-root", "running");

    expect(revisions).toEqual([before]);
    expect(tree.getSnapshot().revision).toBe(before + 1);
    expect(tree.getSnapshot().resources.controllerTurns.consumed).toBe(1);
  });
});

function createTree(limits: {
  readonly maxTotalDescendantRuns: number;
  readonly maxActiveDescendantRuns: number;
  readonly maxDescendantDepth: number;
}, now = STARTED_AT): RunTreeExecution {
  return new RunTreeExecution({
    rootRunId: "run-root",
    startedAt: STARTED_AT,
    deadlineAt: DEADLINE_AT,
    limits,
    resources: treeResources(),
    rootAuthorityRevision: "root-authority-v1",
    now: () => now,
  });
}

function reserve(
  tree: RunTreeExecution,
  parentLineage: RunLineage,
  parentRunId: string,
  childRunId: string,
  actionSequence: number,
) {
  return tree.reserveDescendant({
    relationId: `relation-${childRunId}`,
    createChildRunId: () => childRunId,
    parentRunId,
    parentLineage,
    parentRunAction: action(parentRunId, actionSequence),
    parentDeadlineAt: DEADLINE_AT,
    childLocalDeadlineAt: DEADLINE_AT,
    resourceAllocation: resourceAmounts(100),
    authorityRevision: `${childRunId}-authority-v1`,
  });
}

function treeResources() {
  return Object.freeze({
    controllerTurns: { maximum: 1_000, enforcement: "hard" as const },
    actions: { maximum: 1_000, enforcement: "hard" as const },
    modelInputTokens: { maximum: 1_000, enforcement: "observational" as const },
    modelOutputTokens: { maximum: 1_000, enforcement: "observational" as const },
    costUnits: { maximum: 1_000, enforcement: "observational" as const },
    contextBytes: { maximum: 1_000, enforcement: "hard" as const },
    resultBytes: { maximum: 1_000, enforcement: "hard" as const },
  });
}

function resourceAmounts(value: number) {
  return Object.freeze({
    controllerTurns: value,
    actions: value,
    modelInputTokens: value,
    modelOutputTokens: value,
    costUnits: value,
    contextBytes: value,
    resultBytes: value,
  });
}

function action(runId: string, sequence: number): RunActionRef {
  return Object.freeze({
    run: Object.freeze({ id: runId }),
    id: `${runId}:action:${sequence}`,
    sequence,
  });
}

function cancellation(runId: string) {
  return createRunCancellationController({
    runId,
    now: () => STARTED_AT,
    createRequestId: (id) => `${id}:cancellation`,
  });
}
