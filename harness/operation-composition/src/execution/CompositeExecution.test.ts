import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import { createOperationResult, type OperationResult } from "@agent-anything/operation-catalog/result";
import { describe, expect, it, vi } from "vitest";
import { snapshotCompositeDefinition, type CompositeDefinitionRevision } from "../definition/index.js";
import { CompositeExecution, type CompositeConflictResolverPort } from "./CompositeExecution.js";

const NOW = "2026-08-13T00:00:00.000Z";

describe("CompositeExecution", () => {
  it("rejects cyclic graphs before an execution can exist", () => {
    expect(() => snapshotCompositeDefinition(definition([
      node("first", ["second"]),
      node("second", ["first"]),
    ]))).toThrow(/acyclic/);
  });

  it("serializes independent nodes when no complete non-conflict proof exists", async () => {
    let active = 0;
    let maximumActive = 0;
    const starts: string[] = [];
    const execution = createExecution({
      conflicts: null,
      start: async (nodeId, sequence) => {
        starts.push(nodeId);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return child(nodeId, sequence, "succeeded");
      },
    });

    const result = await execution.run({}, activeInterruption());

    expect(result.status).toBe("succeeded");
    expect(starts).toEqual(["first", "second"]);
    expect(maximumActive).toBe(1);
  });

  it("starts a bounded parallel wave only with current non-conflict evidence", async () => {
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const conflicts: CompositeConflictResolverPort = {
      revision: "conflict-1",
      evaluate: () => ({
        revision: "conflict-1",
        status: "non_conflicting",
        evidenceRef: "proof-1",
      }),
    };
    const execution = createExecution({
      conflicts,
      start: async (nodeId, sequence) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (active === 2) release();
        await gate;
        active -= 1;
        return child(nodeId, sequence, "succeeded");
      },
    });

    const result = await execution.run({}, activeInterruption());

    expect(result.status).toBe("succeeded");
    expect(maximumActive).toBe(2);
  });

  it("preserves unknown effect as the aggregate truth", async () => {
    const execution = createExecution({
      conflicts: null,
      start: async (nodeId, sequence) => child(
        nodeId,
        sequence,
        nodeId === "second" ? "unknown_effect" : "succeeded",
      ),
    });

    const result = await execution.run({}, activeInterruption());

    expect(result.status).toBe("unknown_effect");
    expect(result.output).toBeNull();
    expect(result.children.map(({ status }) => status)).toEqual([
      "succeeded",
      "unknown_effect",
    ]);
  });

  it("cancels every unstarted node without invoking a child", async () => {
    const start = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const execution = createExecution({ conflicts: null, start });

    const result = await execution.run({}, {
      signal: controller.signal,
      interruption: {
        kind: "run_cancellation",
        cancellation: { runId: "run-1", requestId: "cancel-1" },
      },
    });

    expect(start).not.toHaveBeenCalled();
    expect(result.status).toBe("cancelled");
    expect(result.children.every(({ status }) => status === "cancelled_before_start"))
      .toBe(true);
  });
});

function createExecution(input: {
  readonly conflicts: CompositeConflictResolverPort | null;
  readonly start: (
    nodeId: string,
    sequence: number,
  ) => Promise<{ readonly runAction: RunActionRef; readonly result: OperationResult }>;
}): CompositeExecution {
  let sequence = 0;
  return new CompositeExecution(
    "composite-1",
    snapshotCompositeDefinition(definition([node("first"), node("second")])),
    {
      transforms: [{ id: "identity", transform: ({ compositeInput }) => compositeInput }],
      conditions: [],
      reducer: {
        id: "collect",
        reduce: ({ children }) => ({ statuses: children.map(({ status }) => status) }),
      },
      conflicts: input.conflicts,
      children: {
        start: ({ node: childNode }) => {
          sequence += 1;
          return input.start(childNode.id, sequence);
        },
      },
      now: () => NOW,
    },
  );
}

function definition(
  nodes: CompositeDefinitionRevision["nodes"],
): CompositeDefinitionRevision {
  return {
    ref: { id: "composite-definition", revision: "1" },
    inputSchemaRevision: "input-1",
    resultSchemaRevision: "result-1",
    graphRevision: "graph-1",
    nodes,
    join: { kind: "all_selected_settled" },
    reducerId: "collect",
    conflictPolicyRevision: "conflict-1",
    limits: { maxNodes: 4, maxParallel: 2 },
    cancellationPolicy: "cancel_unstarted_and_signal_active",
    sensitivity: "internal",
    retiredAt: null,
  };
}

function node(
  id: string,
  dependencies: readonly string[] = [],
): CompositeDefinitionRevision["nodes"][number] {
  return {
    id,
    operation: operation(id),
    allowedBindings: ["internal"],
    dependencies,
    transformId: "identity",
    conditionId: null,
    resourceClaims: [{ family: "test", identity: id, access: "observe" }],
    required: true,
  };
}

function child(
  nodeId: string,
  sequence: number,
  status: "succeeded" | "unknown_effect",
): { readonly runAction: RunActionRef; readonly result: OperationResult } {
  const runAction: RunActionRef = {
    run: { id: "run-1" },
    id: `action-${nodeId}`,
    sequence,
  };
  const invocation = { id: `invocation-${nodeId}`, operation: operation(nodeId) };
  const base = {
    ref: { invocation, id: `result-${nodeId}` },
    binding: { operation: invocation.operation, revision: "binding-1" },
    semanticOwner: "test",
    startedAt: NOW,
    finishedAt: NOW,
    lowerRefs: [],
    metadata: {},
  };
  const result = status === "succeeded"
    ? createOperationResult({ ...base, status, output: { nodeId }, failure: null })
    : createOperationResult({
        ...base,
        status,
        output: null,
        failure: {
          owner: "test",
          code: "effect_unknown",
          message: "The child effect could not be determined.",
          retryable: false,
          metadata: {},
        },
      });
  return { runAction, result };
}

function operation(name: string) {
  return {
    operation: { namespace: "test", name },
    revision: "1",
  };
}

function activeInterruption(): InvocationInterruptionContext {
  return { signal: new AbortController().signal, interruption: null };
}
