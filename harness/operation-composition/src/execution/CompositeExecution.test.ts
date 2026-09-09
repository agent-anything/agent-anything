import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import { createOperationResult, type OperationResult } from "@agent-anything/operation-catalog/result";
import { describe, expect, it, vi } from "vitest";
import { snapshotCompositeDefinition, type CompositeDefinitionRevision } from "../definition/index.js";
import { CompositeExecution, type CompositeConflictResolverPort, type CompositeExecutionDependencies } from "./CompositeExecution.js";

const NOW = "2026-08-13T00:00:00.000Z";

describe("CompositeExecution", () => {
  it("publishes exact definitions and immutable node snapshots without observer authority", async () => {
    const graph = definition([node("first"), { ...node("second"), dependencies: [{ nodeId: "first", requirement: "succeeded" }] }]);
    const snapshots: ReturnType<CompositeExecution["getSnapshot"]>[] = [];
    const observed = configuredExecution(graph, { observer(definition, snapshot) {
      expect(definition.nodes[1]?.dependencies).toEqual([{ nodeId: "first", requirement: "succeeded" }]);
      snapshots.push(snapshot);
      throw new Error("diagnostic unavailable");
    } });
    const baseline = configuredExecution(graph);
    expect(await observed.run({}, activeInterruption())).toEqual(await baseline.run({}, activeInterruption()));
    expect(snapshots[0]?.nodes.every((node) => node.lifecycle === "declared")).toBe(true);
    expect(snapshots.at(-1)?.terminal?.status).toBe("succeeded");
    expect(snapshots.some((snapshot) => snapshot.nodes.some((node) => node.lifecycle === "active"))).toBe(true);
  });
  it.each(["succeeded", "settled"] as const)("honors explicit %s dependencies with complete failure settlements", async (requirement) => {
    const seen: unknown[] = [];
    const graph = definition([node("first"), { ...node("second"), dependencies: [{ nodeId: "first", requirement }] }]);
    const execution = configuredExecution(graph, {
      transforms: [{ id: "identity", transform: ({ dependencies }) => { seen.push(dependencies); return {}; } }],
      children: { start: async ({ node: current }) => child(current.id, 1, current.id === "first" ? "failed" : "succeeded") },
    });
    const result = await execution.run({}, activeInterruption());
    expect(result.children[1]?.status).toBe(requirement === "succeeded" ? "dependency_failed" : "succeeded");
    if (requirement === "settled") expect(seen[1]).toMatchObject({ first: { status: "failed", result: { status: "failed" } } });
    else expect(seen).toHaveLength(1);
  });

  it("passes missing-result handler failures to settlement-only recovery without losing cause", async () => {
    const graph = definition([{ ...node("first"), transformId: "fail" },
      { ...node("second"), dependencies: [{ nodeId: "first", requirement: "settled" }] }]);
    const observe = vi.fn(() => ({}));
    const result = await configuredExecution(graph, { transforms: [
      { id: "fail", transform() { throw new Error("transform evidence"); } },
      { id: "identity", transform: observe },
    ] }).run({}, activeInterruption());
    expect(observe.mock.calls[0]?.[0]).toMatchObject({ dependencies: { first: {
      status: "failed", result: null, failure: { code: "composite_transform_failed", message: "transform evidence" },
    } } });
    expect(result.children[1]?.status).toBe("succeeded");
  });

  it("rejects missing registered handlers before any child dispatch", () => {
    const start = vi.fn();
    expect(() => configuredExecution(definition([{ ...node("first"), transformId: "missing" }]), { children: { start } })).toThrow(/unregistered/);
    expect(start).not.toHaveBeenCalled();
  });

  it.each(["condition", "reducer"] as const)("contains %s failures with exact attribution", async (stage) => {
    const graph = definition([{ ...node("first"), conditionId: stage === "condition" ? "fail" : null }]);
    const result = await configuredExecution(graph, {
      conditions: [{ id: "fail", evaluate() { throw new Error("condition failed"); } }],
      reducer: { id: "collect", reduce() { if (stage === "reducer") throw new Error("reducer failed"); return {}; } },
    }).run({}, activeInterruption());
    expect(result.status).toBe("failed");
    expect(stage === "condition" ? result.children[0]?.failure?.code : result.failure?.code).toBe(`composite_${stage}_failed`);
  });

  it("does not turn unsatisfied quorum or required success into aggregate success", async () => {
    for (const join of [{ kind: "quorum", count: 2 }, { kind: "all_required_succeeded" }] as const) {
      const graph = { ...definition([node("first"), node("second")]), join };
      const result = await configuredExecution(graph, { children: {
        start: async ({ node: current }) => child(current.id, 1, current.id === "first" ? "succeeded" : "failed"),
      } }).run({}, activeInterruption());
      expect(result.status).toBe("failed");
    }
  });

  it("stops later waves after unknown effects and retains child dispatch exceptions", async () => {
    const start = vi.fn(async () => { throw new Error("lost settlement"); });
    const result = await configuredExecution(definition([node("first"), node("second")]), { children: { start } })
      .run({}, activeInterruption());
    expect(start).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("unknown_effect");
    expect(result.children[0]?.failure?.message).toBe("lost settlement");
    expect(result.children[1]?.status).toBe("invalidated");
  });

  it("drains started branches on early join and never dispatches an invocation twice", async () => {
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { started = resolve; });
    const graph = { ...definition([node("first"), node("second"), node("third")]), join: { kind: "first_success" as const } };
    const start = vi.fn(async ({ node: current }: Parameters<CompositeExecutionDependencies["children"]["start"]>[0]) => {
      if (current.id === "second") { started(); await pending; }
      return child(current.id, 1, "succeeded");
    });
    const execution = configuredExecution(graph, { children: { start }, conflicts: {
      revision: "conflict-1", evaluate: () => ({ revision: "conflict-1", status: "non_conflicting", evidenceRef: "proof" }),
    } });
    const run = execution.run({}, activeInterruption());
    expect(execution.run({}, activeInterruption())).toBe(run);
    await active;
    expect(execution.getSnapshot().terminal).toBeNull();
    release();
    const result = await run;
    expect(start).toHaveBeenCalledTimes(2);
    expect(result.children.map(({ status }) => status)).toEqual(["succeeded", "succeeded", "not_selected"]);
  });

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
    dependencies: dependencies.map((nodeId) => ({ nodeId, requirement: "succeeded" as const })),
    transformId: "identity",
    conditionId: null,
    resourceClaims: [{ family: "test", identity: id, access: "observe" }],
    required: true,
  };
}

function child(
  nodeId: string,
  sequence: number,
  status: "succeeded" | "unknown_effect" | "failed",
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

function configuredExecution(graph: CompositeDefinitionRevision, overrides: Partial<CompositeExecutionDependencies> = {}) {
  return new CompositeExecution("composite", snapshotCompositeDefinition(graph), {
    transforms: [{ id: "identity", transform: ({ compositeInput }) => compositeInput }],
    conditions: [], reducer: { id: "collect", reduce: ({ children }) => children }, conflicts: null,
    children: { start: async ({ node: current }) => child(current.id, 1, "succeeded") }, now: () => NOW,
    ...overrides,
  });
}
