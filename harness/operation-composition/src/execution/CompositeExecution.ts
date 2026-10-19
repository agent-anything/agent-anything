import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { CompositeCommitError, CompositeRecoveryError, type CompositeCommit, type CompositeCommitPort } from "./CompositeCommitPort.js";
import { ExecutionFlowPath, type ExecutionFlowContext } from "@agent-anything/observability/execution-flow";
import { COMPOSITE_EXECUTION_FLOW, COMPOSITE_NODE_FLOW } from "./CompositeExecutionFlow.js";
import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import type { OperationResult } from "@agent-anything/operation-catalog/result";
import { snapshotCompositeDefinition } from "../definition/index.js";
import type {
  CompositeDefinitionRevision,
  CompositeNodeDefinition,
  CompositeResourceClaim,
} from "../definition/index.js";
import type {
  CompositeFailure,
  CompositeNodeSettlement,
  CompositeNodeTerminalStatus,
  CompositeResult,
} from "../result/index.js";

export type CompositeNodeLifecycle =
  | "declared"
  | "waiting_dependencies"
  | "ready"
  | "prepared"
  | "active"
  | "waiting"
  | "settled";

export interface CompositeNodeState {
  readonly nodeId: string;
  readonly instance: number;
  readonly lifecycle: CompositeNodeLifecycle;
  readonly runAction: RunActionRef | null;
  readonly settlement: CompositeNodeSettlement | null;
}

export interface CompositeExecutionSnapshot {
  readonly revision: number;
  readonly compositeId: string;
  readonly definition: CompositeDefinitionRevision["ref"];
  readonly nodes: readonly CompositeNodeState[];
  readonly terminal: CompositeResult | null;
}

export interface CompositeTransformPort {
  readonly id: string;
  transform(input: {
    readonly compositeInput: unknown;
    readonly dependencies: Readonly<Record<string, CompositeNodeSettlement>>;
  }): unknown;
}

export interface CompositeConditionPort {
  readonly id: string;
  evaluate(input: {
    readonly compositeInput: unknown;
    readonly dependencies: Readonly<Record<string, CompositeNodeSettlement>>;
  }): boolean;
}

export interface CompositeConflictProof {
  readonly revision: string;
  readonly status: "non_conflicting" | "conflicting" | "inconclusive";
  readonly evidenceRef: string | null;
}

export interface CompositeConflictResolverPort {
  readonly revision: string;
  evaluate(left: readonly CompositeResourceClaim[], right: readonly CompositeResourceClaim[]): CompositeConflictProof;
}

export interface CompositeReducerPort {
  readonly id: string;
  reduce(input: {
    readonly compositeInput: unknown;
    readonly children: readonly CompositeNodeSettlement[];
    readonly aggregateStatus: CompositeResult["status"];
    readonly aggregateFailure: CompositeFailure | null;
  }):
    | {readonly status: "succeeded"; readonly output: unknown; readonly failure: null}
    | {readonly status: "partial"; readonly output: unknown; readonly failure: CompositeFailure}
    | {readonly status: "failed" | "cancelled" | "unknown_effect"; readonly output: unknown; readonly failure: CompositeFailure};
}

export interface CompositeChildExecutionPort {
  start(input: {
    readonly executionFlow?: ExecutionFlowContext;
    readonly compositeId: string;
    readonly definition: CompositeDefinitionRevision["ref"];
    readonly node: CompositeNodeDefinition;
    readonly instance: number;
    readonly request: unknown;
    readonly interruption: InvocationInterruptionContext;
  }): Promise<
    | { readonly runAction: RunActionRef; readonly result: OperationResult }
    | { readonly runAction: RunActionRef | null; readonly result: null; readonly failure: CompositeFailure }
  >;
}

export interface CompositeExecutionDependencies {
  readonly commits?: {readonly runId: string; readonly port: CompositeCommitPort};
  readonly recovery?: {
    readonly checkpoint: CompositeCommit;
    /** Reconcile admitted work; this callback must never launch a replacement. */
    readonly reconcile: (input: {
      readonly compositeId: string;
      readonly node: CompositeNodeDefinition;
      readonly state: CompositeNodeState;
      readonly request: unknown;
      readonly interruption: InvocationInterruptionContext;
    }) => Promise<CompositeNodeSettlement>;
  };
  readonly executionFlow?: ExecutionFlowContext & {readonly runId: string};
  readonly observer?: (definition: CompositeDefinitionRevision, snapshot: CompositeExecutionSnapshot) => void;
  readonly transforms: readonly CompositeTransformPort[];
  readonly conditions: readonly CompositeConditionPort[];
  readonly reducer: CompositeReducerPort;
  readonly conflicts: CompositeConflictResolverPort | null;
  readonly children: CompositeChildExecutionPort;
  readonly now?: () => string;
}

/** Invocation-local sole writer for one bounded Composite Operation. */
export class CompositeExecution {
  private revision = 0;
  private readonly states = new Map<string, CompositeNodeState>();
  private terminal: CompositeResult | null = null;
  private running: Promise<CompositeResult> | null = null;
  private readonly transforms: ReadonlyMap<string, CompositeTransformPort>;
  private readonly conditions: ReadonlyMap<string, CompositeConditionPort>;
  private readonly now: () => string;
  private flow: ExecutionFlowPath | null = null;
  private readonly nodeFlows = new Map<string, ExecutionFlowPath>();
  private readonly requests = new Map<string, unknown>();
  private input: unknown = null;
  private startedAt = "";
  private commitTail: Promise<unknown> = Promise.resolve();
  private commitFailure: CompositeCommitError | null = null;

  constructor(
    readonly compositeId: string,
    readonly definition: CompositeDefinitionRevision,
    private readonly dependencies: CompositeExecutionDependencies,
  ) {
    this.definition = snapshotCompositeDefinition(definition);
    this.transforms = uniqueById(dependencies.transforms, "Composite transform");
    this.conditions = uniqueById(dependencies.conditions, "Composite condition");
    if (dependencies.reducer.id !== definition.reducerId) {
      throw new TypeError("Composite reducer does not match the definition revision.");
    }
    if (
      dependencies.conflicts !== null &&
      dependencies.conflicts.revision !== definition.conflictPolicyRevision
    ) {
      throw new TypeError("Composite conflict resolver revision does not match the definition.");
    }
    this.now = dependencies.now ?? (() => new Date().toISOString());
    for (const node of this.definition.nodes) {
      if (!this.transforms.has(node.transformId) ||
          (node.conditionId !== null && !this.conditions.has(node.conditionId))) {
        throw new TypeError(`Composite node '${node.id}' references an unregistered handler.`);
      }
      this.states.set(node.id, frozenState(node.id, "declared", null, null));
    }
    if (dependencies.recovery) this.restoreCheckpoint(dependencies.recovery.checkpoint);
    this.publish();
  }

  getSnapshot(): CompositeExecutionSnapshot {
    return Object.freeze({
      revision: this.revision,
      compositeId: this.compositeId,
      definition: this.definition.ref,
      nodes: Object.freeze(this.definition.nodes.map((node) => this.states.get(node.id)!)),
      terminal: this.terminal,
    });
  }

  run(compositeInput: unknown, interruption: InvocationInterruptionContext): Promise<CompositeResult> {
    if (this.dependencies.recovery && !sameSavedValue(compositeInput, this.input)) {
      return Promise.reject(new CompositeRecoveryError(this.compositeId, "composite_input_changed"));
    }
    this.running ??= this.execute(compositeInput, interruption);
    return this.running;
  }

  private async execute(compositeInput: unknown, interruption: InvocationInterruptionContext): Promise<CompositeResult> {
    const observation = this.dependencies.executionFlow;
    if (observation) this.flow = new ExecutionFlowPath(COMPOSITE_EXECUTION_FLOW, observation, observation.runId,
      [{owner:"operation-composition",kind:"operation",id:this.compositeId,revision:null}]);
    try {
      if (this.dependencies.recovery) {
        const step = this.flow?.advance("recover", {revision: this.revision, commitId: this.dependencies.recovery.checkpoint.id});
        await this.reconcileInterruptedNodes(interruption);
        step?.check("reconciliation", "passed");
        if (this.terminal !== null) {
          this.flow?.close("returned");
          return this.terminal;
        }
      }
      this.flow?.advance("eligibility");
      const result = await this.executeGraph(compositeInput, interruption);
      this.flow?.close(result.status === "cancelled" ? "cancelled" : "returned");
      return result;
    } catch (error) { this.flow?.close("failed"); throw error; }
  }

  private async executeGraph(compositeInput: unknown, interruption: InvocationInterruptionContext): Promise<CompositeResult> {
    const startedAt = this.dependencies.recovery ? this.startedAt : this.now();
    if (!this.dependencies.recovery) {
      this.input = structuredClone(compositeInput);
      this.startedAt = startedAt;
      await this.persist(this.getSnapshot(), null, this.requests);
    }
    if ([...this.states.values()].some(state => state.settlement?.status === "unknown_effect")) {
      await this.settleAggregate(compositeInput, startedAt, "unknown_effect");
    } else if (interruption.signal.aborted) {
      await this.cancelUnstarted();
      await this.settleAggregate(compositeInput, startedAt, "cancelled");
    } else if (joinSatisfied(this.definition, this.states)) {
      await this.markRemainingNotSelected();
      await this.settleAggregate(compositeInput, startedAt);
    }
    while (this.terminal === null) {
      if (interruption.signal.aborted) {
        await this.cancelUnstarted();
        await this.settleAggregate(compositeInput, startedAt, "cancelled");
        break;
      }
      await this.refreshEligibility(compositeInput);
      const ready = this.definition.nodes.filter((node) => ["ready", "prepared"].includes(this.states.get(node.id)!.lifecycle));
      if (ready.length === 0) {
        await this.settleAggregate(compositeInput, startedAt);
        break;
      }
      let wave: readonly CompositeNodeDefinition[];
      try {
        this.flow?.advance("schedule", {readyCount:ready.length,maxParallel:this.definition.limits.maxParallel});
        wave = this.selectWave(ready);
      } catch (error) {
        await this.settleAggregate(compositeInput, startedAt, "failed",
          handlerFailure("conflict", this.definition.conflictPolicyRevision, error));
        break;
      }
      this.flow?.advance("dispatch", {waveSize:wave.length});
      // Each branch contains callback failures; the wave drains before any next dispatch.
      const outcomes = await Promise.allSettled(wave.map(async (node) => {
        if (interruption.signal.aborted) {
          await this.commitTerminal(node.id, "cancelled_before_start", null, null);
          return;
        }
        let request: unknown;
        if (this.states.get(node.id)!.lifecycle === "prepared") {
          request = this.requests.get(node.id);
        } else {
          try {
            this.nodeFlows.get(node.id)?.advance("transform", {transformId:node.transformId});
            request = structuredClone(this.transforms.get(node.transformId)!.transform({
              compositeInput, dependencies: this.dependencySettlements(node),
            }));
            if (request === undefined) throw new TypeError("Composite transform must return an explicit request; use null for an empty request.");
          } catch (error) {
            await this.commitTerminal(node.id, "failed", null, null, handlerFailure("transform", node.transformId, error));
            return;
          }
          await this.commitLifecycle(node.id, "prepared", request);
        }
        await this.commitLifecycle(node.id, "active");
        try {
          this.nodeFlows.get(node.id)?.advance("execute");
          const child = await this.dependencies.children.start({
            executionFlow:this.nodeFlows.get(node.id)?.callContext,
            compositeId: this.compositeId, definition: this.definition.ref,
            node, instance: 1, request, interruption,
          });
          if (child.result === null) await this.commitTerminal(node.id, "invalid", child.runAction, null, child.failure);
          else await this.commitTerminal(node.id, operationStatus(child.result.status), child.runAction, child.result);
        } catch (error) {
          if (error instanceof CompositeCommitError) throw error;
          // A dispatch exception without a settlement cannot prove absence of effects.
          await this.commitTerminal(node.id, "unknown_effect", null, null, handlerFailure("child_execution", node.id, error));
        }
      }));
      const rejected = outcomes.find(outcome => outcome.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      const join = this.flow?.advance("join", {waveSize:wave.length});
      if (join) for (const node of wave) {
        const nodeFlow = this.nodeFlows.get(node.id);
        if (nodeFlow?.current) this.flow!.link(nodeFlow.current.ref, join.ref, "join");
      }
      if ([...this.states.values()].some((state) => state.settlement?.status === "unknown_effect")) {
        await this.settleAggregate(compositeInput, startedAt, "unknown_effect");
      } else if (interruption.signal.aborted) {
        await this.cancelUnstarted();
        await this.settleAggregate(compositeInput, startedAt, "cancelled");
      } else if (joinSatisfied(this.definition, this.states)) {
        await this.markRemainingNotSelected();
        await this.settleAggregate(compositeInput, startedAt);
      }
      if (this.terminal === null) this.flow?.advance("eligibility");
    }
    this.publish();
    return this.terminal!;
  }

  private restoreCheckpoint(source: CompositeCommit): void {
    const saved = structuredClone(source);
    const invalid = () => { throw new CompositeRecoveryError(this.compositeId, "composite_checkpoint_invalid"); };
    if (!this.dependencies.commits || this.dependencies.commits.runId !== saved.runId ||
        saved.state.compositeId !== this.compositeId ||
        !sameSavedValue(saved.definition, this.definition) ||
        !sameSavedValue(saved.state.definition, this.definition.ref) ||
        !Number.isSafeInteger(saved.state.revision) || saved.state.revision < 0 ||
        saved.id !== `${this.compositeId}:commit:${saved.state.revision}` ||
        saved.expectedRevision !== (saved.state.revision === 0 ? null : saved.state.revision - 1) ||
        !Number.isFinite(Date.parse(saved.startedAt)) ||
        saved.state.nodes.length !== this.definition.nodes.length) invalid();
    const nodes = new Map(saved.state.nodes.map(node => [node.nodeId, node]));
    if (nodes.size !== this.definition.nodes.length) invalid();
    for (const entry of saved.requests) {
      if (!nodes.has(entry.nodeId) || entry.instance !== 1 || entry.request === undefined || this.requests.has(entry.nodeId)) invalid();
      this.requests.set(entry.nodeId, entry.request);
    }
    for (const definition of this.definition.nodes) {
      const node = nodes.get(definition.id);
      if (!node || node.instance !== 1 ||
          !["declared", "waiting_dependencies", "ready", "prepared", "active", "waiting", "settled"].includes(node.lifecycle) ||
          (node.lifecycle === "settled") !== (node.settlement !== null) ||
          (["prepared", "active", "waiting"].includes(node.lifecycle) && !this.requests.has(node.nodeId))) invalid();
      if (!node) throw new CompositeRecoveryError(this.compositeId, "composite_checkpoint_invalid");
      if (node.settlement) this.validateReconciledNode(definition, node, node.settlement);
      this.states.set(definition.id, Object.freeze(node));
    }
    if (saved.state.terminal !== null && (
      saved.state.terminal.compositeId !== this.compositeId ||
      !sameSavedValue(saved.state.terminal.definition, this.definition.ref) ||
      saved.state.terminal.startedAt !== saved.startedAt ||
      saved.state.nodes.some(node => node.lifecycle !== "settled") ||
      !sameSavedValue(saved.state.terminal.children, this.definition.nodes.map(node => nodes.get(node.id)!.settlement))
    )) invalid();
    this.input = saved.input;
    this.startedAt = saved.startedAt;
    this.revision = saved.state.revision;
    this.terminal = saved.state.terminal;
  }

  private async reconcileInterruptedNodes(interruption: InvocationInterruptionContext): Promise<void> {
    const recovery = this.dependencies.recovery!;
    const active = this.definition.nodes.filter(node => ["active", "waiting"].includes(this.states.get(node.id)!.lifecycle));
    const outcomes = await Promise.allSettled(active.map(async node => {
      const state = this.states.get(node.id)!;
      const settlement = structuredClone(await recovery.reconcile({
        compositeId: this.compositeId, node, state, request: this.requests.get(node.id), interruption,
      }));
      this.validateReconciledNode(node, state, settlement);
      await this.commitTerminal(node.id, settlement.status, settlement.runAction, settlement.result, settlement.failure);
    }));
    const rejected = outcomes.find(outcome => outcome.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  }

  private validateReconciledNode(node: CompositeNodeDefinition, state: CompositeNodeState, settlement: CompositeNodeSettlement): void {
    if (settlement.nodeId !== node.id || settlement.instance !== state.instance ||
        !["succeeded", "partial", "failed", "unavailable", "denied", "cancelled", "timed_out", "invalid", "unknown_effect",
          "not_selected", "dependency_failed", "invalidated", "cancelled_before_start"].includes(settlement.status) ||
        (state.runAction !== null && !sameSavedValue(state.runAction, settlement.runAction)) ||
        (settlement.result !== null && (
          settlement.result.status !== settlement.status ||
          !sameSavedValue(settlement.result.ref.invocation.operation, node.operation)
        )) ||
        (["succeeded", "partial"].includes(settlement.status) && settlement.result === null)) {
      throw new CompositeRecoveryError(this.compositeId, "composite_reconciled_result_invalid");
    }
  }

  private dependencySettlements(node: CompositeNodeDefinition): Readonly<Record<string, CompositeNodeSettlement>> {
    return Object.freeze(Object.fromEntries(node.dependencies.map(({ nodeId }) => {
      const settlement = this.states.get(nodeId)!.settlement;
      if (settlement === null) throw new TypeError("Composite dependency has not settled.");
      return [nodeId, settlement];
    })));
  }

  private async refreshEligibility(compositeInput: unknown): Promise<void> {
    // Revisit blocked nodes after propagating a prerequisite outcome, independent of declaration order.
    let changed: boolean;
    do {
      changed = false;
      for (const node of this.definition.nodes) {
        const state = this.states.get(node.id)!;
        if (state.lifecycle !== "declared" && state.lifecycle !== "waiting_dependencies") continue;
        let nodeFlow = this.nodeFlows.get(node.id);
        if (!nodeFlow && this.flow) {
          nodeFlow = new ExecutionFlowPath(COMPOSITE_NODE_FLOW, {...this.flow.callContext,relationship:"spawn"},this.flow.runId,
            [{owner:"operation-composition",kind:"operation",id:`${this.compositeId}:${node.id}`,revision:null}]);
          this.nodeFlows.set(node.id,nodeFlow);
        }
        const check = nodeFlow?.advance("dependencies", {nodeId:node.id,dependencyCount:node.dependencies.length});
        const settled = node.dependencies.every(({nodeId})=>this.states.get(nodeId)!.lifecycle === "settled");
        check?.check("dependencies_settled", settled ? "passed" : "not_satisfied");
        if (!settled) {
          await this.commitLifecycle(node.id, "waiting_dependencies");
          continue;
        }
        changed = true;
        const succeeded = node.dependencies.every(({nodeId,requirement})=>requirement !== "succeeded" || this.states.get(nodeId)!.settlement!.status === "succeeded");
        check?.check("dependencies_succeeded", succeeded ? "passed" : "not_satisfied");
        if (!succeeded) {
          await this.commitTerminal(node.id, "dependency_failed", null, null, {
            code: "composite_dependency_failed", message: "A required-success prerequisite did not succeed.",
            retryable: false, metadata: { dependencies: node.dependencies },
          });
          continue;
        }
        try {
          const condition = node.conditionId === null ? null : this.conditions.get(node.conditionId)!;
          const selected = condition === null || condition.evaluate({ compositeInput, dependencies: this.dependencySettlements(node) });
          check?.check("condition", condition === null ? "not_applicable" : selected ? "passed" : "not_satisfied", {conditionId:node.conditionId});
          if (!selected) {
            await this.commitTerminal(node.id, "not_selected", null, null);
          } else {
            await this.commitLifecycle(node.id, "ready");
          }
        } catch (error) {
          if (error instanceof CompositeCommitError) throw error;
          await this.commitTerminal(node.id, "failed", null, null, handlerFailure("condition", node.conditionId!, error));
        }
      }
    } while (changed);
  }

  private selectWave(ready: readonly CompositeNodeDefinition[]): readonly CompositeNodeDefinition[] {
    const selected: CompositeNodeDefinition[] = [];
    for (const candidate of ready) {
      if (selected.length >= this.definition.limits.maxParallel) break;
      if (selected.length === 0) {
        selected.push(candidate);
        continue;
      }
      if (this.dependencies.conflicts === null) break;
      const safe = selected.every((current) => {
        const proof = this.dependencies.conflicts!.evaluate(current.resourceClaims, candidate.resourceClaims);
        const accepted = proof.revision === this.definition.conflictPolicyRevision &&
          proof.status === "non_conflicting" && proof.evidenceRef !== null;
        this.flow?.current?.check("resource_conflict", accepted ? "passed" : "not_satisfied",
          {left:current.id,right:candidate.id,policyRevision:proof.revision,evidenceRef:proof.evidenceRef,status:proof.status});
        return accepted;
      });
      if (!safe) break;
      selected.push(candidate);
    }
    return Object.freeze(selected);
  }

  private commitLifecycle(nodeId: string, lifecycle: CompositeNodeLifecycle, request?: unknown): Promise<void> {
    return this.commitChange(() => {
      const current = this.states.get(nodeId)!;
      return frozenState(nodeId, lifecycle, current.runAction, current.settlement);
    }, request);
  }

  private async commitTerminal(
    nodeId: string,
    status: CompositeNodeTerminalStatus,
    runAction: RunActionRef | null,
    result: OperationResult | null,
    failure: CompositeFailure | null = null,
  ): Promise<void> {
    const settlement = Object.freeze({ nodeId, instance: 1, runAction, status, result,
      failure: failure === null ? result?.failure ?? null : Object.freeze(failure) });
    await this.commitChange(() => frozenState(nodeId, "settled", runAction, settlement));
    const flow = this.nodeFlows.get(nodeId);
    flow?.advance("settle", {status,nodeId});
    flow?.close("returned");
  }

  private publish(): void {
    if (!this.dependencies.observer) return;
    try { void Promise.resolve(this.dependencies.observer(this.definition, this.getSnapshot())).catch(() => {}); }
    catch { /* Optional observation cannot alter Composite progression. */ }
  }

  private async markRemainingNotSelected(): Promise<void> {
    for (const state of this.states.values()) {
      if (state.lifecycle !== "settled") await this.commitTerminal(state.nodeId, "not_selected", null, null);
    }
  }

  private async cancelUnstarted(): Promise<void> {
    for (const state of this.states.values()) {
      if (state.lifecycle !== "settled") await this.commitTerminal(state.nodeId, "cancelled_before_start", null, null);
    }
  }

  private async settleAggregate(
    compositeInput: unknown,
    startedAt: string,
    forcedStatus?: CompositeResult["status"],
    cause: CompositeFailure | null = null,
  ): Promise<void> {
    this.flow?.advance("reduce", {forcedStatus:forcedStatus ?? null,reducerId:this.dependencies.reducer.id});
    for (const node of this.definition.nodes) {
      if (this.states.get(node.id)!.lifecycle !== "settled") await this.commitTerminal(node.id, "invalidated", null, null);
    }
    const children = Object.freeze(this.definition.nodes.map((node) => this.states.get(node.id)!.settlement!));
    let status = children.some((child) => child.status === "unknown_effect")
      ? "unknown_effect" as const : forcedStatus ?? deriveAggregateStatus(children, joinSatisfied(this.definition, this.states));
    let output: unknown = null;
    const aggregateStatus = status;
    const aggregateFailure = status === "succeeded" ? null : cause ?? Object.freeze({
      code: `composite_${status}`, message: `Composite Operation settled as ${status}.`,
      retryable: false, metadata: Object.freeze({}),
    });
    let reductionFailure: CompositeFailure | null = null;
    try {
        const reduced = this.dependencies.reducer.reduce(Object.freeze({ compositeInput, children,
          aggregateStatus, aggregateFailure }));
        if (!reduced || !["succeeded", "partial", "failed", "cancelled", "unknown_effect"].includes(reduced.status) ||
            (reduced.status === "succeeded" ? reduced.failure !== null : reduced.failure === null) ||
            (reduced.status === "partial" && reduced.output === null)) throw new TypeError("Invalid Composite semantic reduction.");
        if (aggregateStatus !== "succeeded" && reduced.status !== aggregateStatus &&
            !(aggregateStatus === "partial" && reduced.status === "failed")) {
          this.flow?.current?.check("aggregate_preserved", "not_satisfied", {aggregateStatus,reducedStatus:reduced.status});
          throw new TypeError("Composite reduction cannot replace its aggregate failure or uncertainty.");
        }
        this.flow?.current?.check("aggregate_preserved", "passed", {aggregateStatus,reducedStatus:reduced.status});
        output = reduced.output;
        status = reduced.status;
        cause = reduced.failure;
    } catch (error) {
      reductionFailure = handlerFailure("reducer", this.dependencies.reducer.id, error);
      if (aggregateStatus === "succeeded" || aggregateStatus === "partial") status = "failed";
      cause = aggregateFailure ?? reductionFailure;
    }
    this.flow?.current?.check("result_construction", reductionFailure === null ? "passed" : "not_satisfied",
      {reducerId:this.dependencies.reducer.id,aggregateStatus,status,code:reductionFailure?.code??null});
    const failure = status === "succeeded" ? null : cause ?? Object.freeze({
      code: `composite_${status}`, message: `Composite Operation settled as ${status}.`,
      retryable: false, metadata: Object.freeze({
        children: children.map((child) => ({ nodeId: child.nodeId, status: child.status,
          runAction: child.runAction, resultRef: child.result?.ref ?? null,
          output: child.result?.output ?? null, failure: child.failure })),
      }),
    });
    const terminal: CompositeResult = Object.freeze({
      compositeId: this.compositeId, definition: this.definition.ref, status,
      children, output, failure, startedAt, finishedAt: this.now(),
      reduction: Object.freeze({ reducerId: this.dependencies.reducer.id, aggregateStatus,
        status: reductionFailure === null ? "constructed" as const : "failed" as const, failure: reductionFailure }),
    });
    const next = {...this.getSnapshot(), revision: this.revision + 1, terminal};
    await this.persist(next, this.revision, this.requests);
    this.terminal = terminal;
    this.revision = next.revision;
  }

  private commitChange(prepare: () => CompositeNodeState, request?: unknown): Promise<void> {
    const result = this.commitTail.then(async () => {
      if (this.commitFailure) throw this.commitFailure;
      const node = prepare();
      const requests = new Map(this.requests);
      if (request !== undefined) requests.set(node.nodeId, request);
      const next = {...this.getSnapshot(), revision: this.revision + 1,
        nodes: this.definition.nodes.map(value => value.id === node.nodeId ? node : this.states.get(value.id)!)};
      await this.persist(next, this.revision, requests);
      this.states.set(node.nodeId, node);
      if (request !== undefined) this.requests.set(node.nodeId, request);
      this.revision = next.revision;
      this.publish();
    });
    this.commitTail = result.catch(error => { this.commitFailure = error; });
    return result;
  }

  private async persist(state: CompositeExecutionSnapshot, expectedRevision: number | null, requests: ReadonlyMap<string, unknown>): Promise<void> {
    const binding = this.dependencies.commits;
    if (!binding) return;
    const id = `${this.compositeId}:commit:${state.revision}`;
    try {
      const receipt = await binding.port.commitComposite({id, expectedRevision, runId: binding.runId,
        definition: this.definition, input: this.input, startedAt: this.startedAt, state,
        requests: [...requests].map(([nodeId, request]) => ({nodeId, instance: 1, request}))});
      if (receipt.recordId !== id || receipt.revision !== state.revision) throw new TypeError("Composite receipt mismatch.");
    } catch (cause) { throw new CompositeCommitError(id, {cause}); }
  }
}

function sameSavedValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object" ||
      Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameSavedValue(a[key], b[key]));
}

function uniqueById<T extends { readonly id: string }>(input: readonly T[], kind: string): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const value of input) {
    if (result.has(value.id)) throw new TypeError(`${kind} '${value.id}' is duplicated.`);
    result.set(value.id, value);
  }
  return result;
}

function frozenState(
  nodeId: string,
  lifecycle: CompositeNodeLifecycle,
  runAction: RunActionRef | null,
  settlement: CompositeNodeSettlement | null,
): CompositeNodeState {
  return Object.freeze({ nodeId, instance: 1, lifecycle, runAction, settlement });
}

function operationStatus(status: OperationResult["status"]): CompositeNodeTerminalStatus {
  return status;
}

function joinSatisfied(
  definition: CompositeDefinitionRevision,
  states: ReadonlyMap<string, CompositeNodeState>,
): boolean {
  const settled = definition.nodes.map((node) => states.get(node.id)!.settlement).filter((value): value is CompositeNodeSettlement => value !== null);
  const successes = settled.filter((value) => value.status === "succeeded").length;
  switch (definition.join.kind) {
    case "first_success": return successes > 0;
    case "quorum": return successes >= definition.join.count;
    case "all_selected_settled": return settled.length === definition.nodes.length;
    case "all_required_succeeded":
      return definition.nodes.filter((node) => node.required).every((node) => states.get(node.id)!.settlement?.status === "succeeded");
  }
}

function deriveAggregateStatus(
  children: readonly CompositeNodeSettlement[],
  satisfied: boolean,
): CompositeResult["status"] {
  if (children.some((child) => child.status === "unknown_effect")) return "unknown_effect";
  if (children.some((child) => child.status === "cancelled" || child.status === "cancelled_before_start")) return "cancelled";
  if (!satisfied) return "failed";
  const selected = children.filter((child) => child.status !== "not_selected");
  if (selected.some((child) => child.status !== "succeeded")) {
    return selected.some((child) => child.status === "succeeded" || child.status === "partial") ? "partial" : "failed";
  }
  return "succeeded";
}

function handlerFailure(stage: string, handlerId: string, error: unknown): CompositeFailure {
  return Object.freeze({
    code: `composite_${stage}_failed`,
    message: error instanceof Error ? error.message : "Composite callback failed.",
    retryable: false, metadata: Object.freeze({ stage, handlerId }),
  });
}
