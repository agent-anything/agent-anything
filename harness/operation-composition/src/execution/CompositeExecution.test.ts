import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import { createOperationResult, type OperationResult } from "@agent-anything/operation-catalog/result";
import { describe, expect, it, vi } from "vitest";
import { snapshotCompositeDefinition, type CompositeDefinitionRevision } from "../definition/index.js";
import { CompositeExecution, type CompositeConflictResolverPort, type CompositeExecutionDependencies } from "./CompositeExecution.js";
import {CompositeCommitError, CompositeRecoveryError, type CompositeCommit} from "./CompositeCommitPort.js";

const NOW = "2026-08-13T00:00:00.000Z";

describe("CompositeExecution", () => {
  it("recovers prepared requests without repeating transforms or already settled children", async () => {
    const graph = definition([node("first"), node("second", ["first"])]);
    const commits = await recordedExecution(graph);
    const checkpoint = commits.find(commit => commit.state.nodes[1]?.lifecycle === "prepared")!;
    const start = vi.fn(async () => child("second", 2, "succeeded"));
    const transform = vi.fn(() => {throw new Error("must reuse retained request");});
    const reconcile = vi.fn();
    const resumed = configuredExecution(graph, {commits: recording([]),
      recovery: {checkpoint, reconcile}, children: {start},
      transforms: [{id: "identity", transform}], now: () => "2026-08-14T00:00:00.000Z"});
    const result = await resumed.run({original: true}, activeInterruption());
    expect(result.status).toBe("succeeded");
    expect(result.startedAt).toBe(NOW);
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({node: expect.objectContaining({id: "second"}), request: {original: true}}));
    expect(transform).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(result.children[0]).toEqual(checkpoint.state.nodes[0]?.settlement);
  });

  it.each(["succeeded", "unknown_effect"] as const)("reconciles admitted work as %s without redispatch", async status => {
    const graph = definition([node("first"), node("second", ["first"])]);
    const commits = await recordedExecution(graph);
    const checkpoint = commits.find(commit => commit.state.nodes[0]?.lifecycle === "active")!;
    const result = child("first", 1, status);
    const reconcile = vi.fn(async () => ({nodeId: "first", instance: 1, status,
      ...result, failure: result.result.failure}));
    const start = vi.fn(async () => child("second", 2, "succeeded"));
    const restored = configuredExecution(graph, {commits: recording([]), recovery: {checkpoint, reconcile}, children: {start}});
    const output = await restored.run({original: true}, activeInterruption());
    expect(reconcile).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledTimes(status === "succeeded" ? 1 : 0);
    expect(output.status).toBe(status);
    expect(output.children[1]?.status).toBe(status === "succeeded" ? "succeeded" : "invalidated");
  });

  it("retains an already satisfied early join across recovery", async () => {
    const graph = {...definition([node("first"), node("second")]), join: {kind: "first_success" as const}};
    const checkpoint = (await recordedExecution(graph)).find(commit => commit.state.nodes[0]?.lifecycle === "settled")!;
    const start = vi.fn();
    const restored = configuredExecution(graph, {commits: recording([]), recovery: {checkpoint, reconcile: vi.fn()}, children: {start}});
    const result = await restored.run({original: true}, activeInterruption());
    expect(start).not.toHaveBeenCalled();
    expect(result.status).toBe("succeeded");
    expect(result.children[1]?.status).toBe("not_selected");
  });

  it("reuses terminal aggregates without dispatch, reduction or additional commits", async () => {
    const graph = definition([node("first")]);
    const checkpoint = (await recordedExecution(graph)).at(-1)!;
    const next: CompositeCommit[] = [];
    const start = vi.fn();
    const reduce = vi.fn();
    const restored = configuredExecution(graph, {commits: recording(next), recovery: {checkpoint, reconcile: vi.fn()},
      children: {start}, reducer: {id: "collect", reduce}});
    expect(await restored.run({original: true}, activeInterruption())).toEqual(checkpoint.state.terminal);
    expect(next).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    expect(reduce).not.toHaveBeenCalled();
  });

  it("honors cancellation before completing a recovered nonterminal early join", async () => {
    const graph = {...definition([node("first"), node("second")]), join: {kind: "first_success" as const}};
    const checkpoint = (await recordedExecution(graph)).find(commit => commit.state.nodes[0]?.lifecycle === "settled")!;
    const abort = new AbortController();
    abort.abort();
    const start = vi.fn();
    const restored = configuredExecution(graph, {commits: recording([]), recovery: {checkpoint, reconcile: vi.fn()}, children: {start}});
    const result = await restored.run({original: true}, {...activeInterruption(), signal: abort.signal});
    expect(result.status).toBe("cancelled");
    expect(result.children[0]).toEqual(checkpoint.state.nodes[0]?.settlement);
    expect(result.children[1]?.status).toBe("cancelled_before_start");
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects changed input, graph, missing requests and incorrectly correlated reconciliation", async () => {
    const graph = definition([node("first")]);
    const checkpoint = (await recordedExecution(graph)).find(commit => commit.state.nodes[0]?.lifecycle === "active")!;
    const dependencies = {commits: recording([]), recovery: {checkpoint, reconcile: vi.fn()}};
    await expect(configuredExecution(graph, dependencies).run({original: false}, activeInterruption())).rejects.toBeInstanceOf(CompositeRecoveryError);
    expect(() => configuredExecution({...graph, graphRevision: "changed"}, dependencies)).toThrow(CompositeRecoveryError);
    expect(() => configuredExecution(graph, {...dependencies, recovery: {...dependencies.recovery,
      checkpoint: {...checkpoint, requests: []}}})).toThrow(CompositeRecoveryError);
    const start = vi.fn();
    const result = child("other", 1, "succeeded");
    const restored = configuredExecution(graph, {...dependencies, children: {start}, recovery: {checkpoint,
      reconcile: async () => ({nodeId: "first", instance: 1, status: "succeeded", ...result, failure: null})}});
    await expect(restored.run({original: true}, activeInterruption())).rejects.toBeInstanceOf(CompositeRecoveryError);
    expect(start).not.toHaveBeenCalled();
  });
  it("rejects missing transform output before retaining a prepared node or dispatching", async () => {
    const start = vi.fn();
    const commits: CompositeCommit[] = [];
    const execution = configuredExecution(definition([node("first")]), {commits: recording(commits),
      transforms: [{id: "identity", transform: () => undefined}], children: {start}});
    const result = await execution.run({}, activeInterruption());
    expect(start).not.toHaveBeenCalled();
    expect(commits.some(commit => commit.state.nodes[0]?.lifecycle === "prepared")).toBe(false);
    expect(result.children[0]?.failure?.code).toBe("composite_transform_failed");
  });

  it("retains generated requests before dispatch and every child settlement before dependent reduction", async () => {
    const commits: CompositeCommit[] = [];
    const execution = configuredExecution(definition([node("first"), {...node("second"), dependencies: [{nodeId: "first", requirement: "succeeded"}]}]), {
      commits: {runId: "run-1", port: {
        async commitComposite(commit) { commits.push(structuredClone(commit)); return {recordId: commit.id, revision: commit.state.revision}; },
        async readCompositeCommit(id) { return commits.find(commit => commit.id === id) ?? null; },
      }},
      transforms: [{id: "identity", transform: ({dependencies}) => ({sources: Object.keys(dependencies)})}],
      children: {async start(input) {
        const saved = commits.at(-1)!;
        expect(saved.requests.find(request => request.nodeId === input.node.id)?.request).toEqual(input.request);
        expect(saved.state.nodes.find(node => node.nodeId === input.node.id)?.lifecycle).toBe("active");
        return child(input.node.id, 1, "succeeded");
      }},
    });
    const result = await execution.run({source: "original"}, activeInterruption());
    expect(result.status).toBe("succeeded");
    expect(commits.at(-1)?.state.terminal).toEqual(result);
    expect(commits.at(-1)?.requests[1]?.request).toEqual({sources: ["first"]});
    expect(commits.map(commit => commit.state.revision)).toEqual(commits.map((_, index) => index));
  });

  it("does not dispatch or publish prepared state after a failed durable acknowledgement", async () => {
    const start = vi.fn(async () => child("first", 1, "succeeded"));
    const execution = configuredExecution(definition([node("first")]), {
      children: {start}, commits: {runId: "run-1", port: {
        async commitComposite(commit) {
          if (commit.requests.length > 0) throw new Error("disk unavailable");
          return {recordId: commit.id, revision: commit.state.revision};
        }, async readCompositeCommit() {return null;},
      }},
    });
    await expect(execution.run({}, activeInterruption())).rejects.toBeInstanceOf(CompositeCommitError);
    expect(start).not.toHaveBeenCalled();
    expect(execution.getSnapshot().nodes[0]?.lifecycle).toBe("ready");
    expect(execution.getSnapshot().terminal).toBeNull();
  });
  it.each(["failed", "cancelled", "unknown_effect"] as const)("constructs diagnostic output for %s without changing execution facts", async status => {
    const reduce = vi.fn(({aggregateStatus, aggregateFailure, children}: Parameters<CompositeExecutionDependencies["reducer"]["reduce"]>[0]) => ({
      status: aggregateStatus, output: { settled: children.length }, failure: aggregateFailure,
    }));
    const result = await configuredExecution(definition([node("first")]), {
      children: { start: async () => child("first", 1, status) }, reducer: {id: "collect", reduce: reduce as CompositeExecutionDependencies["reducer"]["reduce"]},
    }).run({}, activeInterruption());
    expect(reduce).toHaveBeenCalledOnce();
    expect(result).toMatchObject({status, output: {settled: 1}, reduction: {status: "constructed", aggregateStatus: status}});
    expect(result.children[0]?.result?.status).toBe(status);
  });

  it("retains unknown effects and cancellation when the reducer throws or tries to promote them", async () => {
    for (const status of ["unknown_effect", "cancelled"] as const) {
      for (const throws of [true, false]) {
        const result = await configuredExecution(definition([node("first")]), {
          children: {start: async () => child("first", 1, status)},
          reducer: {id: "collect", reduce() {
            if (throws) throw new Error("cannot present");
            return {status: "succeeded", output: {}, failure: null};
          }},
        }).run({}, activeInterruption());
        expect(result).toMatchObject({status, output: null, reduction: {status: "failed", failure: {code: "composite_reducer_failed"}}});
        expect(result.children[0]?.result?.status).toBe(status);
      }
    }
  });
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
      reducer: { id: "collect", reduce() { if (stage === "reducer") throw new Error("reducer failed"); return {status:"succeeded",output:{},failure:null}; } },
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
        reduce: ({ children }) => ({ status:"succeeded", output:{ statuses: children.map(({ status }) => status) }, failure:null }),
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
  status: "succeeded" | "unknown_effect" | "failed" | "cancelled",
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
    conditions: [], reducer: { id: "collect", reduce: ({ children, aggregateStatus, aggregateFailure }) =>
      aggregateStatus === "succeeded" ? {status:"succeeded",output:children,failure:null} :
        {status:aggregateStatus,output:children,failure:aggregateFailure!} }, conflicts: null,
    children: { start: async ({ node: current }) => child(current.id, 1, "succeeded") }, now: () => NOW,
    ...overrides,
  });
}

function recording(commits: CompositeCommit[]): NonNullable<CompositeExecutionDependencies["commits"]> {
  return {runId: "run-1", port: {
    async commitComposite(commit) {commits.push(structuredClone(commit)); return {recordId: commit.id, revision: commit.state.revision};},
    async readCompositeCommit(id) {return commits.find(commit => commit.id === id) ?? null;},
  }};
}

async function recordedExecution(graph: CompositeDefinitionRevision): Promise<CompositeCommit[]> {
  const commits: CompositeCommit[] = [];
  await configuredExecution(graph, {commits: recording(commits)}).run({original: true}, activeInterruption());
  return commits;
}
