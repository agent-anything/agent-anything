import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
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
  }): unknown;
}

export interface CompositeChildExecutionPort {
  start(input: {
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
    this.running ??= this.execute(compositeInput, interruption);
    return this.running;
  }

  private async execute(compositeInput: unknown, interruption: InvocationInterruptionContext): Promise<CompositeResult> {
    const startedAt = this.now();
    while (this.terminal === null) {
      if (interruption.signal.aborted) {
        this.cancelUnstarted();
        this.terminal = this.settleAggregate(compositeInput, startedAt, "cancelled");
        break;
      }
      this.refreshEligibility(compositeInput);
      const ready = this.definition.nodes.filter((node) => this.states.get(node.id)!.lifecycle === "ready");
      if (ready.length === 0) {
        this.terminal = this.settleAggregate(compositeInput, startedAt);
        break;
      }
      let wave: readonly CompositeNodeDefinition[];
      try {
        wave = this.selectWave(ready);
      } catch (error) {
        this.terminal = this.settleAggregate(compositeInput, startedAt, "failed",
          handlerFailure("conflict", this.definition.conflictPolicyRevision, error));
        break;
      }
      // Each branch contains callback failures; the wave drains before any next dispatch.
      await Promise.all(wave.map(async (node) => {
        if (interruption.signal.aborted) {
          this.commitTerminal(node.id, "cancelled_before_start", null, null);
          return;
        }
        let request: unknown;
        try {
          request = this.transforms.get(node.transformId)!.transform({
            compositeInput, dependencies: this.dependencySettlements(node),
          });
        } catch (error) {
          this.commitTerminal(node.id, "failed", null, null, handlerFailure("transform", node.transformId, error));
          return;
        }
        this.commitLifecycle(node.id, "prepared");
        this.commitLifecycle(node.id, "active");
        try {
          const child = await this.dependencies.children.start({
            compositeId: this.compositeId, definition: this.definition.ref,
            node, instance: 1, request, interruption,
          });
          if (child.result === null) this.commitTerminal(node.id, "invalid", child.runAction, null, child.failure);
          else this.commitTerminal(node.id, operationStatus(child.result.status), child.runAction, child.result);
        } catch (error) {
          // A dispatch exception without a settlement cannot prove absence of effects.
          this.commitTerminal(node.id, "unknown_effect", null, null, handlerFailure("child_execution", node.id, error));
        }
      }));
      if ([...this.states.values()].some((state) => state.settlement?.status === "unknown_effect")) {
        this.terminal = this.settleAggregate(compositeInput, startedAt, "unknown_effect");
      } else if (interruption.signal.aborted) {
        this.cancelUnstarted();
        this.terminal = this.settleAggregate(compositeInput, startedAt, "cancelled");
      } else if (joinSatisfied(this.definition, this.states)) {
        this.markRemainingNotSelected();
        this.terminal = this.settleAggregate(compositeInput, startedAt);
      }
    }
    this.publish();
    return this.terminal;
  }

  private dependencySettlements(node: CompositeNodeDefinition): Readonly<Record<string, CompositeNodeSettlement>> {
    return Object.freeze(Object.fromEntries(node.dependencies.map(({ nodeId }) => {
      const settlement = this.states.get(nodeId)!.settlement;
      if (settlement === null) throw new TypeError("Composite dependency has not settled.");
      return [nodeId, settlement];
    })));
  }

  private refreshEligibility(compositeInput: unknown): void {
    // Revisit blocked nodes after propagating a prerequisite outcome, independent of declaration order.
    let changed: boolean;
    do {
      changed = false;
      for (const node of this.definition.nodes) {
        const state = this.states.get(node.id)!;
        if (state.lifecycle !== "declared" && state.lifecycle !== "waiting_dependencies") continue;
        if (node.dependencies.some(({ nodeId }) => this.states.get(nodeId)!.lifecycle !== "settled")) {
          this.commitLifecycle(node.id, "waiting_dependencies");
          continue;
        }
        changed = true;
        if (node.dependencies.some(({ nodeId, requirement }) =>
            requirement === "succeeded" && this.states.get(nodeId)!.settlement!.status !== "succeeded")) {
          this.commitTerminal(node.id, "dependency_failed", null, null, {
            code: "composite_dependency_failed", message: "A required-success prerequisite did not succeed.",
            retryable: false, metadata: { dependencies: node.dependencies },
          });
          continue;
        }
        try {
          const condition = node.conditionId === null ? null : this.conditions.get(node.conditionId)!;
          if (condition !== null && !condition.evaluate({ compositeInput, dependencies: this.dependencySettlements(node) })) {
            this.commitTerminal(node.id, "not_selected", null, null);
          } else {
            this.commitLifecycle(node.id, "ready");
          }
        } catch (error) {
          this.commitTerminal(node.id, "failed", null, null, handlerFailure("condition", node.conditionId!, error));
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
        return proof.revision === this.definition.conflictPolicyRevision &&
          proof.status === "non_conflicting" && proof.evidenceRef !== null;
      });
      if (!safe) break;
      selected.push(candidate);
    }
    return Object.freeze(selected);
  }

  private commitLifecycle(nodeId: string, lifecycle: CompositeNodeLifecycle): void {
    const current = this.states.get(nodeId)!;
    if (current.lifecycle === lifecycle) return;
    this.states.set(nodeId, frozenState(nodeId, lifecycle, current.runAction, current.settlement));
    this.revision += 1;
    this.publish();
  }

  private commitTerminal(
    nodeId: string,
    status: CompositeNodeTerminalStatus,
    runAction: RunActionRef | null,
    result: OperationResult | null,
    failure: CompositeFailure | null = null,
  ): void {
    const settlement = Object.freeze({ nodeId, instance: 1, runAction, status, result,
      failure: failure === null ? result?.failure ?? null : Object.freeze(failure) });
    this.states.set(nodeId, frozenState(nodeId, "settled", runAction, settlement));
    this.revision += 1;
    this.publish();
  }

  private publish(): void {
    if (!this.dependencies.observer) return;
    try { void Promise.resolve(this.dependencies.observer(this.definition, this.getSnapshot())).catch(() => {}); }
    catch { /* Optional observation cannot alter Composite progression. */ }
  }

  private markRemainingNotSelected(): void {
    for (const state of this.states.values()) {
      if (state.lifecycle !== "settled") this.commitTerminal(state.nodeId, "not_selected", null, null);
    }
  }

  private cancelUnstarted(): void {
    for (const state of this.states.values()) {
      if (state.lifecycle !== "settled") this.commitTerminal(state.nodeId, "cancelled_before_start", null, null);
    }
  }

  private settleAggregate(
    compositeInput: unknown,
    startedAt: string,
    forcedStatus?: CompositeResult["status"],
    cause: CompositeFailure | null = null,
  ): CompositeResult {
    for (const node of this.definition.nodes) {
      if (this.states.get(node.id)!.lifecycle !== "settled") this.commitTerminal(node.id, "invalidated", null, null);
    }
    const children = Object.freeze(this.definition.nodes.map((node) => this.states.get(node.id)!.settlement!));
    let status = children.some((child) => child.status === "unknown_effect")
      ? "unknown_effect" as const : forcedStatus ?? aggregateStatus(children, joinSatisfied(this.definition, this.states));
    let output: unknown = null;
    if (status === "succeeded" || status === "partial") {
      try {
        output = this.dependencies.reducer.reduce({ compositeInput, children });
      } catch (error) {
        status = "failed";
        cause = handlerFailure("reducer", this.dependencies.reducer.id, error);
      }
    }
    const failure = status === "succeeded" ? null : cause ?? Object.freeze({
      code: `composite_${status}`, message: `Composite Operation settled as ${status}.`,
      retryable: false, metadata: Object.freeze({
        children: children.map((child) => ({ nodeId: child.nodeId, status: child.status,
          runAction: child.runAction, failure: child.failure })),
      }),
    });
    return Object.freeze({
      compositeId: this.compositeId, definition: this.definition.ref, status,
      children, output, failure, startedAt, finishedAt: this.now(),
    });
  }
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

function aggregateStatus(
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
