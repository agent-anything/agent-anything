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
    tree.settleResources("run-child-1");
    tree.settleRun("run-child-1", "succeeded", terminal("succeeded"), "2026-08-23T00:00:10.000Z");
    tree.settleDescendantTransfer("run-child-1", "settled");

    const second = reserve(tree, tree.rootLineage, "run-root", "run-child-2", 3);
    expect(second.status).toBe("accepted");
    tree.settleResources("run-child-2");
    tree.settleRun("run-child-2", "failed", terminal("failed"), "2026-08-23T00:00:20.000Z");
    tree.settleDescendantTransfer("run-child-2", "settled");

    expect(reserve(tree, tree.rootLineage, "run-root", "run-child-total", 4))
      .toEqual({ status: "rejected", code: "descendant_run_total_limit_exceeded", treeRevision: 6 });
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
      relationKind: "delegation",
      createChildRunId: () => "run-child",
      parentRunId: "run-root",
      parentLineage: tree.rootLineage,
      parentRunAction: action("run-root", 1),
      parentDeadlineAt: "2026-08-23T00:00:40.000Z",
      childLocalDeadlineAt: "2026-08-23T00:00:50.000Z",
      resourceAllocation: resourceAmounts(100),
      authorityRevision: "run-child-authority-v1",
      dispatch: dispatch(1),
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
      treeRevision: 1,
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
    tree.settleResources("run-child");
    tree.failStart("run-child", "2026-08-23T00:00:01.000Z");

    expect(tree.getSnapshot()).toMatchObject({
      totalDescendantRuns: 1,
      activeDescendantRuns: 0,
    });
    expect(reserve(tree, tree.rootLineage, "run-root", "run-other", 2))
      .toEqual({ status: "rejected", code: "descendant_run_total_limit_exceeded", treeRevision: 3 });
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
      terminal: null,
      completedAt: null,
    });

    tree.settleResources("run-child");
    tree.settleRun(
      "run-child",
      "failed",
      terminal("failed"),
      "2026-08-23T00:00:01.000Z",
    );
    expect(tree.getSnapshot()).toMatchObject({ activeDescendantRuns: 0 });
    expect(tree.getSnapshot().nodes.at(-1)).toMatchObject({
      status: "failed",
      terminal: { code: "runtime_execution_failed" },
      completedAt: "2026-08-23T00:00:01.000Z",
    });
    tree.settleDescendantTransfer("run-child", "settled");
  });

  it("prevents root settlement while a descendant remains active", () => {
    const tree = createTree({
      maxTotalDescendantRuns: 1,
      maxActiveDescendantRuns: 1,
      maxDescendantDepth: 1,
    });
    expect(reserve(tree, tree.rootLineage, "run-root", "run-child", 1).status)
      .toBe("accepted");

    expect(() => tree.settleResources("run-root"))
      .toThrow("before child allocations");
    expect(() => tree.settleRun(
      "run-root",
      "succeeded",
      terminal("succeeded"),
      "2026-08-23T00:00:01.000Z",
    )).toThrow("resource account");
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
    expect(tree.getSnapshot().cancellation).toMatchObject({
      treeRequested: true,
      totalRequests: 3,
    });
    expect(tree.getSnapshot().nodes.map(({ cancellation }) => cancellation?.scope))
      .toEqual(["tree", "subtree", "subtree"]);
  });

  it("isolates subtree cancellation from an unrelated sibling", () => {
    const tree = createTree({
      maxTotalDescendantRuns: 3,
      maxActiveDescendantRuns: 3,
      maxDescendantDepth: 2,
    });
    const first = reserve(tree, tree.rootLineage, "run-root", "run-child-1", 1);
    const sibling = reserve(tree, tree.rootLineage, "run-root", "run-child-2", 2);
    expect(first.status).toBe("accepted");
    expect(sibling.status).toBe("accepted");
    if (first.status !== "accepted" || sibling.status !== "accepted") return;
    const childCancellation = cancellation("run-child-1");
    const siblingCancellation = cancellation("run-child-2");
    tree.registerCancellation("run-child-1", childCancellation);
    tree.registerCancellation("run-child-2", siblingCancellation);
    const grandchild = reserve(tree, first.lineage, "run-child-1", "run-grandchild", 1);
    expect(grandchild.status).toBe("accepted");
    if (grandchild.status !== "accepted") return;
    const grandchildCancellation = cancellation("run-grandchild");
    tree.registerCancellation("run-grandchild", grandchildCancellation);

    childCancellation.requestCancellation({ origin: "user", reasonCode: "user_requested" });

    expect(grandchildCancellation.context.request?.parentRunId).toBe("run-child-1");
    expect(siblingCancellation.context.request).toBeNull();
    expect(tree.getSnapshot().cancellation.treeRequested).toBe(false);
  });

  it("requires resources and one descendant transfer settlement before the root barrier", () => {
    const tree = createTree({
      maxTotalDescendantRuns: 1,
      maxActiveDescendantRuns: 1,
      maxDescendantDepth: 1,
    });
    expect(reserve(tree, tree.rootLineage, "run-root", "run-child", 1).status)
      .toBe("accepted");
    expect(() => tree.settleRun(
      "run-child", "succeeded", terminal("succeeded"), "2026-08-23T00:00:01.000Z",
    )).toThrow("resource account");
    tree.settleResources("run-child");
    tree.settleRun("run-child", "succeeded", terminal("succeeded"), "2026-08-23T00:00:01.000Z");
    tree.settleResources("run-root");
    expect(() => tree.settleRun(
      "run-root", "succeeded", terminal("succeeded"), "2026-08-23T00:00:02.000Z",
    )).toThrow("descendant obligations remain");
    tree.settleDescendantTransfer("run-child", "unknown");
    tree.settleRun("run-root", "succeeded", terminal("succeeded"), "2026-08-23T00:00:02.000Z");
    expect(tree.getSnapshot().settlement).toMatchObject({
      complete: true,
      unsettledDescendantRuns: 0,
      unknownResultTransfers: 1,
    });
    expect(() => tree.settleDescendantTransfer("run-child", "settled"))
      .toThrow("more than once");
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

  it("rejects Approval admission after cancellation without reporting capacity exhaustion", () => {
    const tree = createTree({
      maxTotalDescendantRuns: 1,
      maxActiveDescendantRuns: 1,
      maxDescendantDepth: 1,
    });
    const rootCancellation = cancellation("run-root");
    tree.registerCancellation("run-root", rootCancellation);
    const basis = tree.captureAuthorityBasis("run-root");
    rootCancellation.requestCancellation({ origin: "user", reasonCode: "user_requested" });

    expect(tree.admitApproval({
      requestId: "approval-1",
      runId: "run-root",
      actionId: "action-1",
      authorityRevision: basis.authorityRevision,
      workspaceId: "workspace-1",
      environmentId: "local",
      operationFingerprint: "operation-1",
    })).toEqual({
      status: "rejected",
      code: "approval_tree_cancelled",
      revision: 0,
    });
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
    expect(tree.getSnapshot().resources.controllerTurns).toMatchObject({
      enforcement: "hard",
      measuredConsumed: 1,
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
    resources: treeResources(),
    approvals: approvalLimits(),
    rootAuthorityRevision: "root-authority-v1",
    now: () => now,
  });
}

function approvalLimits() {
  return Object.freeze({
    maxTotalRequests: 20,
    maxRequestsPerOperationFingerprint: 4,
    maxConsecutiveDeclines: 3,
    maxConsecutiveReviewerFailures: 3,
    maxActiveReviews: 2,
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
    relationKind: "delegation",
    createChildRunId: () => childRunId,
    parentRunId,
    parentLineage,
    parentRunAction: action(parentRunId, actionSequence),
    parentDeadlineAt: DEADLINE_AT,
    childLocalDeadlineAt: DEADLINE_AT,
    resourceAllocation: resourceAmounts(100),
    authorityRevision: `${childRunId}-authority-v1`,
    dispatch: dispatch(actionSequence),
  });
}

function dispatch(candidateIndex: number) {
  return Object.freeze({
    schemaVersion: 1 as const,
    requestedForm: "single" as const,
    controllerRequestId: `controller-request-${candidateIndex}`,
    controllerTurnId: `controller-turn-${candidateIndex}`,
    candidateIndex,
    siblingIndex: 0,
    siblingCount: 1,
  });
}

function treeResources() {
  return Object.freeze({
    controllerTurns: { maximum: 1_000, minimumChildGrant: 1, enforcement: "hard" as const },
    actions: { maximum: 1_000, minimumChildGrant: 1, enforcement: "hard" as const },
    modelInputTokens: { threshold: 1_000, enforcement: "observational" as const },
    modelOutputTokens: { threshold: 1_000, enforcement: "observational" as const },
    costUnits: { threshold: 1_000, enforcement: "observational" as const },
    contextBytes: { maximum: 1_000, minimumChildGrant: 1, enforcement: "hard" as const },
    resultBytes: { maximum: 1_000, minimumChildGrant: 1, enforcement: "hard" as const },
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

function terminal(status: "succeeded" | "failed" | "cancelled") {
  const causeKind = status === "succeeded"
    ? "completion" as const
    : status === "failed"
      ? "failure" as const
      : "cancellation" as const;
  return Object.freeze({
    causeId: `cause-${status}`,
    causeRevision: "1",
    causeKind,
    code: status === "succeeded"
      ? "completion_accepted"
      : status === "failed"
        ? "runtime_execution_failed"
        : "runtime_cancelled",
    sourceOwner: "agent-runtime",
    sourceKind: `run_${causeKind}`,
    sourceId: `source-${status}`,
  });
}
