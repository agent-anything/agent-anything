import type { RunLifecycleStatus } from "@agent-anything/agent-core/run";
import {
  createDescendantRunLineage,
  createDescendantRunRelation,
  createRootRunLineage,
  type DescendantRunLineage,
  type DescendantRunRelation,
  type RootRunLineage,
  type RunLineage,
} from "@agent-anything/agent-core/run-tree";
import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import type {
  RunCancellationController,
  RunResultCode,
} from "../run/index.js";
import type { RunTreeLimits } from "./RunConfig.js";
import {
  RunTreeResourceAccount,
  type RunTreeNodeResourceSnapshot,
  type RunTreeResourceAmounts,
  type RunTreeResourceEnvelope,
  type RunTreeResourceMeasurement,
  type RunTreeResourceRecordResult,
  type RunTreeResourceSettlement,
  type RunTreeResourceSnapshot,
} from "./RunTreeResourceAccount.js";

export type DescendantRunReservationFailureCode =
  | "descendant_run_start_cancelled"
  | "descendant_run_deadline_exceeded"
  | "descendant_run_depth_limit_exceeded"
  | "descendant_run_total_limit_exceeded"
  | "descendant_run_active_limit_exceeded"
  | "descendant_run_resource_limit_exceeded";

export interface DescendantRunReservationInput {
  readonly relationId: string;
  readonly createChildRunId: () => string;
  readonly parentRunId: string;
  readonly parentLineage: RunLineage;
  readonly parentRunAction: RunActionRef;
  readonly parentDeadlineAt: string;
  readonly childLocalDeadlineAt: string;
  readonly resourceAllocation: RunTreeResourceAmounts;
  readonly authorityRevision: string;
}

export type DescendantRunReservation =
  | {
      readonly status: "accepted";
      readonly relation: DescendantRunRelation;
      readonly lineage: DescendantRunLineage;
      readonly deadlineAt: string;
      readonly resources: RunTreeNodeResourceSnapshot;
      readonly authorityRevision: string;
      readonly treeRevision: number;
    }
  | {
      readonly status: "rejected";
      readonly code: DescendantRunReservationFailureCode;
      readonly treeRevision: number;
    };

export interface RunTreeNodeProjection {
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly relationId: string | null;
  readonly parentRunActionId: string | null;
  readonly depth: number;
  readonly status: RunLifecycleStatus;
  readonly resultCode: RunResultCode | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly resources: RunTreeNodeResourceSnapshot;
  readonly authorityRevision: string;
}

export interface RunTreeExecutionSnapshot {
  readonly rootRunId: string;
  readonly revision: number;
  readonly deadlineAt: string;
  readonly limits: RunTreeLimits;
  readonly totalDescendantRuns: number;
  readonly activeDescendantRuns: number;
  readonly resources: RunTreeResourceSnapshot;
  readonly nodes: readonly RunTreeNodeProjection[];
}

export interface RunTreeDescendantCapacityAssessment {
  readonly treeRevision: number;
  readonly disposition: "available" | "unavailable";
  readonly reason:
    | "depth_limit_exhausted"
    | "total_limit_exhausted"
    | "active_limit_exhausted"
    | null;
}

export function assessRunTreeDescendantCapacity(
  snapshot: RunTreeExecutionSnapshot,
  parentLineage: RunLineage,
): RunTreeDescendantCapacityAssessment {
  if (parentLineage.root.id !== snapshot.rootRunId) {
    throw new TypeError("Descendant capacity lineage belongs to another Run Tree.");
  }
  const reason = parentLineage.depth + 1 > snapshot.limits.maxDescendantDepth
    ? "depth_limit_exhausted" as const
    : snapshot.totalDescendantRuns >= snapshot.limits.maxTotalDescendantRuns
      ? "total_limit_exhausted" as const
      : snapshot.activeDescendantRuns >= snapshot.limits.maxActiveDescendantRuns
        ? "active_limit_exhausted" as const
        : null;
  return Object.freeze({
    treeRevision: snapshot.revision,
    disposition: reason === null ? "available" : "unavailable",
    reason,
  });
}

export type RunTreeExecutionListener = (
  snapshot: RunTreeExecutionSnapshot,
) => void;

interface MutableRunTreeNode {
  readonly lineage: RunLineage;
  readonly acceptedOrder: number;
  status: RunLifecycleStatus;
  resultCode: RunResultCode | null;
  startedAt: string | null;
  completedAt: string | null;
  readonly admittedAuthorityRevision: string;
  authorityRevisionSequence: number;
}

interface CancellationRegistration {
  readonly controller: RunCancellationController;
  readonly onAbort: () => void;
}

export interface CreateRunTreeExecutionInput {
  readonly rootRunId: string;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly limits: RunTreeLimits;
  readonly resources: RunTreeResourceEnvelope;
  readonly rootAuthorityRevision: string;
  readonly now: () => string;
}

export class RunTreeExecution {
  readonly rootLineage: RootRunLineage;

  private readonly input: CreateRunTreeExecutionInput;
  private readonly nodes = new Map<string, MutableRunTreeNode>();
  private readonly resources: RunTreeResourceAccount;
  private readonly cancellation = new Map<string, CancellationRegistration>();
  private readonly listeners = new Set<RunTreeExecutionListener>();
  private revision = 0;
  private projectionDirty = false;
  private totalDescendantRuns = 0;
  private activeDescendantRuns = 0;
  private snapshot: RunTreeExecutionSnapshot;

  constructor(input: CreateRunTreeExecutionInput) {
    assertToken(input.rootRunId, "rootRunId");
    assertDateTime(input.startedAt, "startedAt");
    assertDateTime(input.deadlineAt, "deadlineAt");
    if (Date.parse(input.deadlineAt) <= Date.parse(input.startedAt)) {
      throw new TypeError("Run Tree deadline must be later than root start time.");
    }
    this.input = Object.freeze({
      ...input,
      limits: Object.freeze({ ...input.limits }),
    });
    assertToken(input.rootAuthorityRevision, "rootAuthorityRevision");
    this.resources = new RunTreeResourceAccount(input.rootRunId, input.resources);
    this.rootLineage = createRootRunLineage({ id: input.rootRunId });
    this.nodes.set(input.rootRunId, {
      lineage: this.rootLineage,
      acceptedOrder: 0,
      status: "initializing",
      resultCode: null,
      startedAt: input.startedAt,
      completedAt: null,
      admittedAuthorityRevision: input.rootAuthorityRevision,
      authorityRevisionSequence: 0,
    });
    this.snapshot = this.createSnapshot();
  }

  reserveDescendant(
    input: DescendantRunReservationInput,
  ): DescendantRunReservation {
    const parent = this.requireParent(input.parentRunId, input.parentLineage);
    if (this.isCancellationRequested(parent.lineage.root.id) ||
        this.isCancellationRequested(input.parentRunId)) {
      return rejected("descendant_run_start_cancelled", this.revision);
    }
    const nowMs = Date.parse(this.input.now());
    const effectiveDeadlineMs = Math.min(
      Date.parse(this.input.deadlineAt),
      Date.parse(input.parentDeadlineAt),
      Date.parse(input.childLocalDeadlineAt),
    );
    if (!Number.isFinite(effectiveDeadlineMs) || nowMs >= effectiveDeadlineMs) {
      return rejected("descendant_run_deadline_exceeded", this.revision);
    }
    const depth = input.parentLineage.depth + 1;
    if (depth > this.input.limits.maxDescendantDepth) {
      return rejected("descendant_run_depth_limit_exceeded", this.revision);
    }
    if (this.totalDescendantRuns >= this.input.limits.maxTotalDescendantRuns) {
      return rejected("descendant_run_total_limit_exceeded", this.revision);
    }
    if (this.activeDescendantRuns >= this.input.limits.maxActiveDescendantRuns) {
      return rejected("descendant_run_active_limit_exceeded", this.revision);
    }
    const childRunId = input.createChildRunId();
    assertToken(childRunId, "childRunId");
    if (this.nodes.has(childRunId)) {
      throw new TypeError("The descendant Run identity already exists in this tree.");
    }

    const relation = createDescendantRunRelation({
      relationId: input.relationId,
      root: this.rootLineage.root,
      parent: { id: input.parentRunId },
      child: { id: childRunId },
      parentRunAction: input.parentRunAction,
      depth,
    });
    const lineage = createDescendantRunLineage(relation);
    assertToken(input.authorityRevision, "authorityRevision");
    const resourceReservation = this.resources.reserve(
      input.parentRunId,
      childRunId,
      input.resourceAllocation,
    );
    if (resourceReservation.status === "rejected") {
      return rejected(resourceReservation.code, this.revision);
    }
    this.totalDescendantRuns += 1;
    this.activeDescendantRuns += 1;
    this.nodes.set(childRunId, {
      lineage,
      acceptedOrder: this.totalDescendantRuns,
      status: "initializing",
      resultCode: null,
      startedAt: null,
      completedAt: null,
      admittedAuthorityRevision: input.authorityRevision,
      authorityRevisionSequence: 0,
    });
    this.commitProjectionChange();
    return Object.freeze({
      status: "accepted" as const,
      relation,
      lineage,
      deadlineAt: new Date(effectiveDeadlineMs).toISOString(),
      resources: this.resources.getNodeSnapshot(childRunId),
      authorityRevision: this.currentAuthorityRevision(childRunId),
      treeRevision: this.revision,
    });
  }

  recordResources(
    runId: string,
    usage: Partial<Record<
      import("./RunTreeResourceAccount.js").RunTreeResourceDimension,
      RunTreeResourceMeasurement
    >>,
  ): RunTreeResourceRecordResult {
    this.requireNode(runId);
    const result = this.resources.record(runId, usage);
    this.projectionDirty = true;
    return result;
  }

  settleResources(runId: string): RunTreeResourceSettlement {
    this.requireNode(runId);
    const settlement = this.resources.settle(runId);
    this.projectionDirty = true;
    return settlement;
  }

  getResourceSettlement(runId: string): RunTreeResourceSettlement | null {
    this.requireNode(runId);
    return this.resources.getSettlement(runId);
  }

  advanceAuthorityRevision(runId: string): string {
    const node = this.requireNode(runId);
    if (isTerminal(node.status)) {
      throw new TypeError("A terminal Run cannot advance authority revision.");
    }
    node.authorityRevisionSequence += 1;
    this.projectionDirty = true;
    return this.currentAuthorityRevision(runId);
  }

  captureAuthorityBasis(runId: string): {
    readonly authorityRevision: string;
    readonly resourceRevision: number;
  } {
    const node = this.requireNode(runId);
    if (isTerminal(node.status)) {
      throw new TypeError("A terminal Run cannot capture Action authority.");
    }
    return Object.freeze({
      authorityRevision: this.currentAuthorityRevision(runId),
      resourceRevision: this.resources.getNodeSnapshot(runId).revision,
    });
  }

  isAuthorityBasisCurrent(
    runId: string,
    basis: { readonly authorityRevision: string; readonly resourceRevision: number },
  ): boolean {
    const node = this.nodes.get(runId);
    return node !== undefined && !isTerminal(node.status) &&
      this.currentAuthorityRevision(runId) === basis.authorityRevision &&
      this.resources.getNodeSnapshot(runId).revision === basis.resourceRevision &&
      !this.isCancellationRequested(runId);
  }

  registerCancellation(
    runId: string,
    controller: RunCancellationController,
  ): void {
    const node = this.requireNode(runId);
    if (isTerminal(node.status)) {
      throw new TypeError("A terminal Run cannot register cancellation control.");
    }
    if (this.cancellation.has(runId)) {
      throw new TypeError("Run cancellation control is already registered.");
    }
    const onAbort = () => this.cancelDescendants(runId);
    this.cancellation.set(runId, { controller, onAbort });
    controller.context.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.context.request !== null) {
      this.cancelDescendants(runId);
    }
  }

  markStarted(runId: string, startedAt: string): void {
    assertDateTime(startedAt, "startedAt");
    const node = this.requireNode(runId);
    if (node.startedAt !== null) return;
    node.startedAt = startedAt;
    this.commitProjectionChange();
  }

  updateLifecycle(runId: string, status: RunLifecycleStatus): void {
    const node = this.requireNode(runId);
    if (isTerminal(node.status)) return;
    if (isTerminal(status)) {
      if (this.projectionDirty) {
        this.commitProjectionChange(runId !== this.input.rootRunId);
      }
      return;
    }
    if (node.status === status) {
      if (this.projectionDirty) {
        this.commitProjectionChange(runId !== this.input.rootRunId);
      }
      return;
    }
    node.status = status;
    this.commitProjectionChange(runId !== this.input.rootRunId);
  }

  settleRun(
    runId: string,
    status: Extract<RunLifecycleStatus, "succeeded" | "blocked" | "failed" | "cancelled">,
    resultCode: RunResultCode | null,
    completedAt: string,
  ): void {
    assertDateTime(completedAt, "completedAt");
    const node = this.requireNode(runId);
    if (isTerminal(node.status)) return;
    if (runId === this.input.rootRunId && this.activeDescendantRuns !== 0) {
      throw new TypeError("The root Run cannot settle while descendants remain active.");
    }
    node.status = status;
    node.resultCode = resultCode;
    node.completedAt = completedAt;
    if (runId !== this.input.rootRunId) {
      this.activeDescendantRuns -= 1;
    }
    this.removeCancellation(runId);
    this.commitProjectionChange(runId !== this.input.rootRunId);
  }

  failStart(runId: string, completedAt: string): void {
    this.settleRun(runId, "failed", "runtime_execution_failed", completedAt);
  }

  hasActiveDescendants(ancestorRunId = this.input.rootRunId): boolean {
    for (const [runId, node] of this.nodes) {
      if (runId !== ancestorRunId && !isTerminal(node.status) &&
          this.isDescendantOf(runId, ancestorRunId)) {
        return true;
      }
    }
    return false;
  }

  getSnapshot(): RunTreeExecutionSnapshot {
    return this.snapshot;
  }

  private currentAuthorityRevision(runId: string): string {
    const node = this.requireNode(runId);
    return `${node.admittedAuthorityRevision}:active:${node.authorityRevisionSequence}`;
  }

  subscribe(listener: RunTreeExecutionListener): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("Run Tree listener must be a function.");
    }
    this.listeners.add(listener);
    notify(listener, this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private cancelDescendants(parentRunId: string): void {
    for (const [runId, registration] of [...this.cancellation]) {
      if (runId === parentRunId || !this.isDescendantOf(runId, parentRunId)) {
        continue;
      }
      registration.controller.requestCancellation({
        origin: "parent_run",
        reasonCode: "parent_run_cancelled",
        parentRunId,
      });
    }
  }

  private isCancellationRequested(runId: string): boolean {
    return (this.cancellation.get(runId)?.controller.context.request ?? null) !== null;
  }

  private isDescendantOf(runId: string, ancestorRunId: string): boolean {
    let current = this.nodes.get(runId);
    while (current?.lineage.kind === "descendant") {
      if (current.lineage.parent.id === ancestorRunId) return true;
      current = this.nodes.get(current.lineage.parent.id);
    }
    return false;
  }

  private requireParent(
    runId: string,
    lineage: RunLineage,
  ): MutableRunTreeNode {
    if (lineage.root.id !== this.input.rootRunId) {
      throw new TypeError("The parent lineage belongs to another Run tree.");
    }
    const node = this.requireNode(runId);
    if (!sameLineage(node.lineage, lineage)) {
      throw new TypeError("The parent lineage does not match the registered Run.");
    }
    if (isTerminal(node.status)) {
      throw new TypeError("A terminal Run cannot create a descendant.");
    }
    return node;
  }

  private requireNode(runId: string): MutableRunTreeNode {
    const node = this.nodes.get(runId);
    if (node === undefined) {
      throw new TypeError(`Run '${runId}' is not registered in this tree.`);
    }
    return node;
  }

  private removeCancellation(runId: string): void {
    const registration = this.cancellation.get(runId);
    if (registration === undefined) return;
    registration.controller.context.signal.removeEventListener(
      "abort",
      registration.onAbort,
    );
    this.cancellation.delete(runId);
  }

  private commitProjectionChange(notifyListeners = true): void {
    this.revision += 1;
    this.snapshot = this.createSnapshot();
    this.projectionDirty = false;
    if (notifyListeners) {
      for (const listener of [...this.listeners]) {
        notify(listener, this.snapshot);
      }
    }
  }

  private createSnapshot(): RunTreeExecutionSnapshot {
    const nodes = [...this.nodes.entries()]
      .sort((left, right) =>
        left[1].lineage.depth - right[1].lineage.depth ||
        left[1].acceptedOrder - right[1].acceptedOrder
      )
      .map(([runId, node]): RunTreeNodeProjection => Object.freeze({
        runId,
        parentRunId: node.lineage.kind === "root" ? null : node.lineage.parent.id,
        relationId: node.lineage.kind === "root" ? null : node.lineage.relation.id,
        parentRunActionId: node.lineage.kind === "root"
          ? null
          : node.lineage.parentRunAction.id,
        depth: node.lineage.depth,
        status: node.status,
        resultCode: node.resultCode,
        startedAt: node.startedAt,
        completedAt: node.completedAt,
        resources: this.resources.getNodeSnapshot(runId),
        authorityRevision: this.currentAuthorityRevision(runId),
      }));
    return Object.freeze({
      rootRunId: this.input.rootRunId,
      revision: this.revision,
      deadlineAt: this.input.deadlineAt,
      limits: this.input.limits,
      totalDescendantRuns: this.totalDescendantRuns,
      activeDescendantRuns: this.activeDescendantRuns,
      resources: this.resources.getSnapshot(this.input.rootRunId),
      nodes: Object.freeze(nodes),
    });
  }
}

function rejected(
  code: DescendantRunReservationFailureCode,
  treeRevision: number,
): DescendantRunReservation {
  return Object.freeze({ status: "rejected" as const, code, treeRevision });
}

function sameLineage(left: RunLineage, right: RunLineage): boolean {
  if (left.kind !== right.kind || left.root.id !== right.root.id ||
      left.depth !== right.depth) {
    return false;
  }
  if (left.kind === "root" || right.kind === "root") return true;
  return left.parent.id === right.parent.id &&
    left.relation.id === right.relation.id &&
    left.parentRunAction.id === right.parentRunAction.id;
}

function isTerminal(status: RunLifecycleStatus): boolean {
  return status === "succeeded" || status === "blocked" ||
    status === "failed" || status === "cancelled";
}

function notify(
  listener: RunTreeExecutionListener,
  snapshot: RunTreeExecutionSnapshot,
): void {
  try {
    listener(snapshot);
  } catch {
    // Observation cannot affect tree execution.
  }
}

function assertToken(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty canonical string.`);
  }
}

function assertDateTime(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid date-time string.`);
  }
}
