import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import type { OperationResult } from "@agent-anything/operation-catalog/result";
import type {
  CompositeDefinitionRevision,
  CompositeNodeDefinition,
  CompositeResourceClaim,
} from "../definition/index.js";
import type {
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
    readonly dependencies: Readonly<Record<string, OperationResult>>;
  }): unknown;
}

export interface CompositeConditionPort {
  readonly id: string;
  evaluate(input: {
    readonly compositeInput: unknown;
    readonly dependencies: Readonly<Record<string, OperationResult>>;
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
  }): Promise<{ readonly runAction: RunActionRef; readonly result: OperationResult }>;
}

export interface CompositeExecutionDependencies {
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
  private readonly transforms: ReadonlyMap<string, CompositeTransformPort>;
  private readonly conditions: ReadonlyMap<string, CompositeConditionPort>;
  private readonly now: () => string;

  constructor(
    readonly compositeId: string,
    readonly definition: CompositeDefinitionRevision,
    private readonly dependencies: CompositeExecutionDependencies,
  ) {
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
    for (const node of definition.nodes) {
      this.states.set(node.id, frozenState(node.id, "declared", null, null));
    }
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

  async run(
    compositeInput: unknown,
    interruption: InvocationInterruptionContext,
  ): Promise<CompositeResult> {
    if (this.terminal !== null) return this.terminal;
    const startedAt = this.now();
    const results = new Map<string, OperationResult>();
    while (this.terminal === null) {
      if (interruption.signal.aborted) {
        this.cancelUnstarted();
        this.terminal = this.settleAggregate(compositeInput, startedAt, "cancelled", results);
        break;
      }
      this.refreshEligibility(compositeInput, results);
      const ready = this.definition.nodes.filter((node) => this.states.get(node.id)!.lifecycle === "ready");
      if (ready.length === 0) {
        this.terminal = this.settleAggregate(compositeInput, startedAt, undefined, results);
        break;
      }
      const wave = this.selectWave(ready);
      await Promise.all(wave.map(async (node) => {
        const transform = this.transforms.get(node.transformId);
        if (transform === undefined) {
          this.commitTerminal(node.id, "invalidated", null, null);
          return;
        }
        const dependencies = dependencyResults(node, results);
        const request = transform.transform({ compositeInput, dependencies });
        this.commitLifecycle(node.id, "prepared");
        this.commitLifecycle(node.id, "active");
        try {
          const child = await this.dependencies.children.start({
            compositeId: this.compositeId,
            definition: this.definition.ref,
            node,
            instance: 1,
            request,
            interruption,
          });
          results.set(node.id, child.result);
          this.commitTerminal(node.id, operationStatus(child.result.status), child.runAction, child.result);
        } catch {
          this.commitTerminal(node.id, "failed", null, null);
        }
      }));
      if (joinSatisfied(this.definition, this.states)) {
        this.markRemainingNotSelected();
        this.terminal = this.settleAggregate(compositeInput, startedAt, undefined, results);
      }
    }
    return this.terminal;
  }

  private refreshEligibility(
    compositeInput: unknown,
    results: ReadonlyMap<string, OperationResult>,
  ): void {
    for (const node of this.definition.nodes) {
      const state = this.states.get(node.id)!;
      if (state.lifecycle !== "declared" && state.lifecycle !== "waiting_dependencies") continue;
      if (node.dependencies.some((dependency) => this.states.get(dependency)!.lifecycle !== "settled")) {
        this.commitLifecycle(node.id, "waiting_dependencies");
        continue;
      }
      const condition = node.conditionId === null ? null : this.conditions.get(node.conditionId);
      if (node.conditionId !== null && condition === undefined) {
        this.commitTerminal(node.id, "invalidated", null, null);
        continue;
      }
      if (condition !== null && condition !== undefined && !condition.evaluate({ compositeInput, dependencies: dependencyResults(node, results) })) {
        this.commitTerminal(node.id, "not_selected", null, null);
        continue;
      }
      this.commitLifecycle(node.id, "ready");
    }
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
  }

  private commitTerminal(
    nodeId: string,
    status: CompositeNodeTerminalStatus,
    runAction: RunActionRef | null,
    result: OperationResult | null,
  ): void {
    const settlement = Object.freeze({ nodeId, instance: 1, runAction, status, result });
    this.states.set(nodeId, frozenState(nodeId, "settled", runAction, settlement));
    this.revision += 1;
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
    forcedStatus: CompositeResult["status"] | undefined,
    results: ReadonlyMap<string, OperationResult>,
  ): CompositeResult {
    for (const node of this.definition.nodes) {
      if (this.states.get(node.id)!.lifecycle !== "settled") {
        this.commitTerminal(node.id, "invalidated", null, results.get(node.id) ?? null);
      }
    }
    const children = Object.freeze(this.definition.nodes.map((node) => this.states.get(node.id)!.settlement!));
    const status = forcedStatus ?? aggregateStatus(this.definition, children);
    const output = status === "succeeded" || status === "partial"
      ? this.dependencies.reducer.reduce({ compositeInput, children })
      : null;
    const failure = status === "succeeded"
      ? null
      : Object.freeze({
          code: `composite_${status}`,
          message: `Composite Operation settled as ${status}.`,
          retryable: false,
          metadata: Object.freeze({ childCount: children.length }),
        });
    return Object.freeze({
      compositeId: this.compositeId,
      definition: this.definition.ref,
      status,
      children,
      output,
      failure,
      startedAt,
      finishedAt: this.now(),
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

function dependencyResults(node: CompositeNodeDefinition, results: ReadonlyMap<string, OperationResult>): Readonly<Record<string, OperationResult>> {
  return Object.freeze(Object.fromEntries(node.dependencies.flatMap((id) => {
    const result = results.get(id);
    return result === undefined ? [] : [[id, result]];
  })));
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
  definition: CompositeDefinitionRevision,
  children: readonly CompositeNodeSettlement[],
): CompositeResult["status"] {
  if (children.some((child) => child.status === "unknown_effect")) return "unknown_effect";
  if (children.some((child) => child.status === "cancelled" || child.status === "cancelled_before_start")) return "cancelled";
  const required = definition.nodes.filter((node) => node.required).map((node) => children.find((child) => child.nodeId === node.id)!);
  if (required.some((child) => child.status !== "succeeded" && child.status !== "partial")) return "failed";
  if (children.some((child) => child.status === "partial" || (child.status !== "succeeded" && child.status !== "not_selected"))) return "partial";
  return "succeeded";
}
