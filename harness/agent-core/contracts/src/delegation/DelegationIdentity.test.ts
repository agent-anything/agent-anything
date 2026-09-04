import { describe, expect, it } from "vitest";
import {
  snapshotDescendantContinuationCorrelation,
  snapshotDelegationOriginCorrelation,
  snapshotDelegationRunCorrelation,
} from "./DelegationIdentity.js";

describe("Agent Core delegation identity", () => {
  it("snapshots exact root, parent, relation, child, and request correlation", () => {
    const origin = rootOrigin();
    const correlation = snapshotDelegationRunCorrelation({
      request: { id: "request-1", revision: "sha256:request" },
      origin,
      relation: {
        ref: { id: "relation-1" },
        kind: "delegation",
        root: { id: "run-root" },
        parent: { id: "run-root" },
        child: { id: "run-child" },
        parentRunAction: origin.parent.action,
        depth: 1,
      },
      child: {
        run: { id: "run-child" },
        task: { id: "task-child" },
        agent: { id: "agent-child", revision: "1" },
      },
    });

    expect(correlation.relation.child.id).toBe("run-child");
    expect(correlation.origin.root.task.id).toBe("task-root");
    expect(Object.isFrozen(correlation)).toBe(true);
    expect(Object.isFrozen(correlation.origin.parent.action.run)).toBe(true);
  });

  it("rejects a parent action from another Run", () => {
    const origin = rootOrigin();
    expect(() => snapshotDelegationOriginCorrelation({
      ...origin,
      parent: {
        ...origin.parent,
        action: { ...origin.parent.action, run: { id: "run-other" } },
      },
    })).toThrow(/must belong to the parent Run/);
  });

  it("rejects a child relation that does not match the trusted origin", () => {
    const origin = rootOrigin();
    expect(() => snapshotDelegationRunCorrelation({
      request: { id: "request-1", revision: "sha256:request" },
      origin,
      relation: {
        ref: { id: "relation-1" },
        kind: "delegation",
        root: { id: "run-root" },
        parent: { id: "run-other" },
        child: { id: "run-child" },
        parentRunAction: {
          run: { id: "run-other" },
          id: "action-1",
          sequence: 1,
        },
        depth: 1,
      },
      child: {
        run: { id: "run-child" },
        task: { id: "task-child" },
        agent: { id: "agent-child", revision: "1" },
      },
    })).toThrow(/does not match its origin/);
  });

  it("keeps a continuation correlation separate from a later child identity", () => {
    const continuation = snapshotDescendantContinuationCorrelation({
      ref: { id: "continuation-1", revision: "sha256:continuation-1" },
      sourceRequest: { id: "request-old", revision: "sha256:request-old" },
      sourceResult: { id: "result-old", revision: "sha256:result-old" },
      root: { id: "run-root" },
      parent: { id: "run-root" },
      sourceChild: { id: "run-old" },
      agent: { id: "agent-child", revision: "1" },
    });

    expect(continuation).not.toHaveProperty("newChild");
    expect(continuation.sourceChild.id).toBe("run-old");
    expect(Object.isFrozen(continuation.sourceResult)).toBe(true);
  });
});

function rootOrigin() {
  return snapshotDelegationOriginCorrelation({
    root: { run: { id: "run-root" }, task: { id: "task-root" } },
    parent: {
      run: { id: "run-root" },
      task: { id: "task-root" },
      action: {
        run: { id: "run-root" },
        id: "action-1",
        sequence: 1,
      },
      lineage: {
        kind: "root",
        root: { id: "run-root" },
        depth: 0,
      },
    },
  });
}
