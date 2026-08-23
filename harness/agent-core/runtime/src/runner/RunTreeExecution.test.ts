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
      .toEqual({ status: "rejected", code: "descendant_run_active_limit_exceeded" });
    tree.settleRun("run-child-1", "succeeded", null, "2026-08-23T00:00:10.000Z");

    const second = reserve(tree, tree.rootLineage, "run-root", "run-child-2", 3);
    expect(second.status).toBe("accepted");
    tree.settleRun("run-child-2", "failed", "runtime_execution_failed", "2026-08-23T00:00:20.000Z");

    expect(reserve(tree, tree.rootLineage, "run-root", "run-child-total", 4))
      .toEqual({ status: "rejected", code: "descendant_run_total_limit_exceeded" });
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
      .toEqual({ status: "rejected", code: "descendant_run_depth_limit_exceeded" });
  });

  it("inherits the earliest tree, parent, and local deadline", () => {
    const tree = createTree({
      maxTotalDescendantRuns: 1,
      maxActiveDescendantRuns: 1,
      maxDescendantDepth: 1,
    });
    const child = tree.reserveDescendant({
      relationId: "relation-1",
      childRunId: "run-child",
      parentRunId: "run-root",
      parentLineage: tree.rootLineage,
      parentRunAction: action("run-root", 1),
      parentDeadlineAt: "2026-08-23T00:00:40.000Z",
      childLocalDeadlineAt: "2026-08-23T00:00:50.000Z",
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
      .toEqual({ status: "rejected", code: "descendant_run_total_limit_exceeded" });
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
    childRunId,
    parentRunId,
    parentLineage,
    parentRunAction: action(parentRunId, actionSequence),
    parentDeadlineAt: DEADLINE_AT,
    childLocalDeadlineAt: DEADLINE_AT,
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
