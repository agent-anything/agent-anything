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
  RunCancellationRequest,
  RunCancellationRequestInput,
  RunCancellationReceipt,
  RunSettlementCauseRecord,
} from "../run/index.js";
import { runSettlementCauseCode } from "../run/index.js";
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
import {
  RunTreeApprovalAccount,
  type RunTreeApprovalAdmission,
  type RunTreeApprovalAdmissionInput,
  type RunTreeApprovalLimits,
  type RunTreeApprovalSettlementKind,
  type RunTreeApprovalSnapshot,
} from "./RunTreeApprovalAccount.js";

export type RunTreeCancellationScope = "subtree" | "tree";
export type DescendantResultTransferStatus =
  | "pending"
  | "settled"
  | "failed"
  | "unknown"
  | "not_required";

export interface DescendantDispatchProvenance {
  readonly schemaVersion: 1;
  readonly requestedForm: "single" | "concurrent_sibling";
  readonly controllerRequestId: string;
  readonly controllerTurnId: string;
  readonly candidateIndex: number;
  readonly siblingIndex: number;
  readonly siblingCount: number;
}

export interface RunTreeCancellationProjection {
  readonly requestId: string;
  readonly initiatingRunId: string;
  readonly scope: RunTreeCancellationScope;
  readonly origin: RunCancellationRequest["origin"];
  readonly reasonCode: RunCancellationRequest["reasonCode"];
  readonly requestedAt: string;
}

export type RunTreeApprovalTreeAdmission = RunTreeApprovalAdmission | {
  readonly status: "rejected";
  readonly code:
    | "approval_tree_cancelled"
    | "approval_tree_run_settled"
    | "approval_tree_authority_stale";
  readonly revision: number;
};

export type DescendantRunReservationFailureCode =
  | "descendant_run_start_cancelled"
  | "descendant_run_deadline_exceeded"
  | "descendant_run_depth_limit_exceeded"
  | "descendant_run_total_limit_exceeded"
  | "descendant_run_active_limit_exceeded"
  | "descendant_run_resource_limit_exceeded";

export interface DescendantRunReservationInput {
  readonly relationId: string;
  readonly relationKind: DescendantRunRelation["kind"];
  readonly createChildRunId: () => string;
  readonly parentRunId: string;
  readonly parentLineage: RunLineage;
  readonly parentRunAction: RunActionRef;
  readonly parentDeadlineAt: string;
  readonly childLocalDeadlineAt: string;
  readonly resourceAllocation: RunTreeResourceAmounts;
  readonly authorityRevision: string;
  readonly dispatch: DescendantDispatchProvenance;
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
  readonly relationKind: DescendantRunRelation["kind"] | null;
  readonly parentRunActionId: string | null;
  readonly dispatch: DescendantDispatchProvenance | null;
  readonly depth: number;
  readonly status: RunLifecycleStatus;
  readonly terminal: RunTreeTerminalProjection | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly resources: RunTreeNodeResourceSnapshot;
  readonly authorityRevision: string;
  readonly cancellation: RunTreeCancellationProjection | null;
  readonly resultTransfer: DescendantResultTransferStatus;
}

export interface RunTreeTerminalProjection {
  readonly causeId: string;
  readonly causeRevision: string;
  readonly causeKind: RunSettlementCauseRecord["kind"];
  readonly code: string;
  readonly sourceOwner: string;
  readonly sourceKind: string;
  readonly sourceId: string;
}

export interface RunTreeSettlementProjection {
  readonly complete: boolean;
  readonly unsettledDescendantRuns: number;
  readonly pendingResultTransfers: number;
  readonly failedResultTransfers: number;
  readonly unknownResultTransfers: number;
}

export interface RunTreeCancellationSummaryProjection {
  readonly totalRequests: number;
  readonly treeRequested: boolean;
  readonly subtreeRequests: number;
  readonly latest: RunTreeCancellationProjection | null;
}

export interface RunTreeExecutionSnapshot {
  readonly rootRunId: string;
  readonly revision: number;
  readonly deadlineAt: string;
  readonly limits: RunTreeLimits;
  readonly totalDescendantRuns: number;
  readonly activeDescendantRuns: number;
  readonly resources: RunTreeResourceSnapshot;
  readonly approvals: RunTreeApprovalSnapshot;
  readonly cancellation: RunTreeCancellationSummaryProjection;
  readonly settlement: RunTreeSettlementProjection;
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
  readonly relationKind: DescendantRunRelation["kind"] | null;
  readonly acceptedOrder: number;
  readonly dispatch: DescendantDispatchProvenance | null;
  status: RunLifecycleStatus;
  terminal: RunTreeTerminalProjection | null;
  startedAt: string | null;
  completedAt: string | null;
  readonly admittedAuthorityRevision: string;
  authorityRevisionSequence: number;
  cancellation: RunTreeCancellationProjection | null;
  resultTransfer: DescendantResultTransferStatus;
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
  readonly approvals: RunTreeApprovalLimits;
  readonly rootAuthorityRevision: string;
  readonly now: () => string;
}

export class RunTreeExecution {
  readonly rootLineage: RootRunLineage;

  private readonly input: CreateRunTreeExecutionInput;
  private readonly nodes = new Map<string, MutableRunTreeNode>();
  private readonly resources: RunTreeResourceAccount;
  private readonly approvals: RunTreeApprovalAccount;
  private readonly cancellation = new Map<string, CancellationRegistration>();
  private readonly listeners = new Set<RunTreeExecutionListener>();
  private revision = 0;
  private projectionDirty = false;
  private totalDescendantRuns = 0;
  private activeDescendantRuns = 0;
  private unsettledDescendantRuns = 0;
  private cancellationRequestCount = 0;
  private latestCancellation: RunTreeCancellationProjection | null = null;
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
    this.approvals = new RunTreeApprovalAccount(input.approvals);
    this.rootLineage = createRootRunLineage({ id: input.rootRunId });
    this.nodes.set(input.rootRunId, {
      lineage: this.rootLineage,
      relationKind: null,
      acceptedOrder: 0,
      dispatch: null,
      status: "initializing",
      terminal: null,
      startedAt: input.startedAt,
      completedAt: null,
      admittedAuthorityRevision: input.rootAuthorityRevision,
      authorityRevisionSequence: 0,
      cancellation: null,
      resultTransfer: "not_required",
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

    const dispatch = snapshotDescendantDispatchProvenance(input.dispatch);
    const relation = createDescendantRunRelation({
      relationId: input.relationId,
      kind: input.relationKind,
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
    this.unsettledDescendantRuns += 1;
    this.nodes.set(childRunId, {
      lineage,
      relationKind: relation.kind,
      acceptedOrder: this.totalDescendantRuns,
      dispatch,
      status: "initializing",
      terminal: null,
      startedAt: null,
      completedAt: null,
      admittedAuthorityRevision: input.authorityRevision,
      authorityRevisionSequence: 0,
      cancellation: null,
      resultTransfer: "pending",
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

  admitApproval(
    input: RunTreeApprovalAdmissionInput,
  ): RunTreeApprovalTreeAdmission {
    const node = this.requireNode(input.runId);
    if (isTerminal(node.status)) {
      return Object.freeze({
        status: "rejected" as const,
        code: "approval_tree_run_settled" as const,
        revision: this.approvals.getSnapshot().revision,
      });
    }
    if (this.isCancellationRequested(input.runId)) {
      return Object.freeze({
        status: "rejected" as const,
        code: "approval_tree_cancelled" as const,
        revision: this.approvals.getSnapshot().revision,
      });
    }
    if (input.authorityRevision !== this.currentAuthorityRevision(input.runId)) {
      return Object.freeze({
        status: "rejected" as const,
        code: "approval_tree_authority_stale" as const,
        revision: this.approvals.getSnapshot().revision,
      });
    }
    const admission = this.approvals.admit(input);
    if (admission.status === "accepted") this.commitProjectionChange();
    return admission;
  }

  settleApproval(
    requestId: string,
    kind: RunTreeApprovalSettlementKind,
  ): RunTreeApprovalSnapshot {
    const snapshot = this.approvals.settle(requestId, kind);
    this.commitProjectionChange();
    return snapshot;
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
    const onAbort = () => this.propagateCancellation(runId);
    this.cancellation.set(runId, { controller, onAbort });
    controller.context.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.context.request !== null) {
      this.propagateCancellation(runId);
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
    status: Extract<RunLifecycleStatus, "succeeded" | "failed" | "cancelled">,
    terminal: RunTreeTerminalProjection,
    completedAt: string,
  ): void {
    assertDateTime(completedAt, "completedAt");
    const projectedTerminal = snapshotRunTreeTerminalProjection(terminal);
    const expectedCauseKind = status === "succeeded"
      ? "completion"
      : status === "failed"
        ? "failure"
        : "cancellation";
    if (projectedTerminal.causeKind !== expectedCauseKind) {
      throw new TypeError("Run Tree terminal cause kind disagrees with lifecycle status.");
    }
    const node = this.requireNode(runId);
    if (isTerminal(node.status)) {
      throw new TypeError("A Run cannot settle more than once.");
    }
    if (this.resources.getSettlement(runId) === null) {
      throw new TypeError(`Run '${runId}' cannot settle before its resource account.`);
    }
    if (this.hasUnsettledDescendantObligations(runId)) {
      throw new TypeError("A Run cannot settle while descendant obligations remain.");
    }
    if (
      runId === this.input.rootRunId &&
      (this.activeDescendantRuns !== 0 ||
        this.unsettledDescendantRuns !== 0 ||
        this.approvals.getSnapshot().activeReviews !== 0)
    ) {
      throw new TypeError("The root Run cannot settle before the aggregate barrier closes.");
    }
    node.status = status;
    node.terminal = projectedTerminal;
    node.completedAt = completedAt;
    if (runId !== this.input.rootRunId) {
      this.activeDescendantRuns -= 1;
    }
    this.removeCancellation(runId);
    this.commitProjectionChange(runId !== this.input.rootRunId);
  }

  failStart(runId: string, completedAt: string): void {
    this.settleRun(runId, "failed", Object.freeze({
      causeId: `${runId}:start-failure`,
      causeRevision: "1",
      causeKind: "failure",
      code: "runtime_execution_failed",
      sourceOwner: "agent-runtime",
      sourceKind: "run_start_failure",
      sourceId: `${runId}:start-failure`,
    }), completedAt);
    this.settleDescendantTransfer(runId, "not_required");
  }

  cancelBeforeStart(runId: string, completedAt: string): void {
    this.settleResources(runId);
    this.settleRun(runId, "cancelled", Object.freeze({
      causeId: `${runId}:pre-start-cancellation`,
      causeRevision: "1",
      causeKind: "cancellation",
      code: "runtime_cancelled",
      sourceOwner: "agent-runtime",
      sourceKind: "run_cancellation_request",
      sourceId: `${runId}:pre-start-cancellation`,
    }), completedAt);
    this.settleDescendantTransfer(runId, "not_required");
  }

  settleDescendantTransfer(
    runId: string,
    status: Exclude<DescendantResultTransferStatus, "pending">,
  ): void {
    const node = this.requireNode(runId);
    if (node.lineage.kind === "root") {
      throw new TypeError("The root Run has no parent result-transfer obligation.");
    }
    if (!isTerminal(node.status) || this.resources.getSettlement(runId) === null) {
      throw new TypeError("Descendant transfer cannot settle before Run and resources.");
    }
    if (node.resultTransfer !== "pending") {
      throw new TypeError("Descendant result transfer cannot settle more than once.");
    }
    node.resultTransfer = status;
    this.unsettledDescendantRuns -= 1;
    this.commitProjectionChange();
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

  requestCancellation(
    runId: string,
    input: RunCancellationRequestInput,
  ): RunCancellationReceipt {
    const registration = this.cancellation.get(runId);
    if (registration === undefined) {
      throw new TypeError(`Run '${runId}' has no active cancellation control.`);
    }
    return registration.controller.requestCancellation(input);
  }

  private propagateCancellation(parentRunId: string): void {
    const initiating = this.cancellation.get(parentRunId)?.controller.context.request;
    if (initiating === null || initiating === undefined) return;
    const node = this.requireNode(parentRunId);
    if (node.cancellation === null) {
      const projection = Object.freeze({
        requestId: initiating.id,
        initiatingRunId: parentRunId,
        scope: parentRunId === this.input.rootRunId ? "tree" as const : "subtree" as const,
        origin: initiating.origin,
        reasonCode: initiating.reasonCode,
        requestedAt: initiating.requestedAt,
      });
      node.cancellation = projection;
      this.latestCancellation = projection;
      this.cancellationRequestCount += 1;
      this.commitProjectionChange();
    }
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
    const node = this.nodes.get(runId);
    if (node?.cancellation !== null && node?.cancellation !== undefined) return true;
    return (this.cancellation.get(runId)?.controller.context.request ?? null) !== null;
  }

  private hasUnsettledDescendantObligations(ancestorRunId: string): boolean {
    for (const [runId, node] of this.nodes) {
      if (
        runId !== ancestorRunId &&
        this.isDescendantOf(runId, ancestorRunId) &&
        (!isTerminal(node.status) || node.resultTransfer === "pending")
      ) {
        return true;
      }
    }
    return false;
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
        relationKind: node.relationKind,
        parentRunActionId: node.lineage.kind === "root"
          ? null
          : node.lineage.parentRunAction.id,
        dispatch: node.dispatch,
        depth: node.lineage.depth,
        status: node.status,
        terminal: node.terminal,
        startedAt: node.startedAt,
        completedAt: node.completedAt,
        resources: this.resources.getNodeSnapshot(runId),
        authorityRevision: this.currentAuthorityRevision(runId),
        cancellation: node.cancellation,
        resultTransfer: node.resultTransfer,
      }));
    const resultTransfers = nodes
      .filter((node) => node.parentRunId !== null)
      .map((node) => node.resultTransfer);
    const approvals = this.approvals.getSnapshot();
    return Object.freeze({
      rootRunId: this.input.rootRunId,
      revision: this.revision,
      deadlineAt: this.input.deadlineAt,
      limits: this.input.limits,
      totalDescendantRuns: this.totalDescendantRuns,
      activeDescendantRuns: this.activeDescendantRuns,
      resources: this.resources.getSnapshot(this.input.rootRunId),
      approvals,
      cancellation: Object.freeze({
        totalRequests: this.cancellationRequestCount,
        treeRequested: nodes.some((node) => node.cancellation?.scope === "tree"),
        subtreeRequests: nodes.filter((node) => node.cancellation?.scope === "subtree").length,
        latest: this.latestCancellation,
      }),
      settlement: Object.freeze({
        complete: this.resources.getSettlement(this.input.rootRunId) !== null &&
          this.activeDescendantRuns === 0 &&
          this.unsettledDescendantRuns === 0 && approvals.activeReviews === 0,
        unsettledDescendantRuns: this.unsettledDescendantRuns,
        pendingResultTransfers: resultTransfers.filter((status) => status === "pending").length,
        failedResultTransfers: resultTransfers.filter((status) => status === "failed").length,
        unknownResultTransfers: resultTransfers.filter((status) => status === "unknown").length,
      }),
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
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function projectRunTreeTerminal(
  cause: RunSettlementCauseRecord,
): RunTreeTerminalProjection {
  return Object.freeze({
    causeId: cause.ref.id,
    causeRevision: cause.ref.revision,
    causeKind: cause.kind,
    code: runSettlementCauseCode(cause),
    sourceOwner: cause.source.owner,
    sourceKind: cause.source.kind,
    sourceId: cause.source.id,
  });
}

function snapshotRunTreeTerminalProjection(
  input: RunTreeTerminalProjection,
): RunTreeTerminalProjection {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Run Tree terminal projection must be an object.");
  }
  assertToken(input.causeId, "terminal.causeId");
  assertToken(input.causeRevision, "terminal.causeRevision");
  assertToken(input.code, "terminal.code");
  assertToken(input.sourceOwner, "terminal.sourceOwner");
  assertToken(input.sourceKind, "terminal.sourceKind");
  assertToken(input.sourceId, "terminal.sourceId");
  if (!["completion", "failure", "cancellation"].includes(input.causeKind)) {
    throw new TypeError("Run Tree terminal cause kind is unsupported.");
  }
  return Object.freeze({ ...input });
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

function snapshotDescendantDispatchProvenance(
  input: DescendantDispatchProvenance,
): DescendantDispatchProvenance {
  if (input === null || typeof input !== "object" || input.schemaVersion !== 1) {
    throw new TypeError("Descendant dispatch provenance must use schema version 1.");
  }
  assertToken(input.controllerRequestId, "dispatch.controllerRequestId");
  assertToken(input.controllerTurnId, "dispatch.controllerTurnId");
  if (input.requestedForm !== "single" && input.requestedForm !== "concurrent_sibling") {
    throw new TypeError("Descendant dispatch form is unsupported.");
  }
  for (const [field, value] of [
    ["candidateIndex", input.candidateIndex],
    ["siblingIndex", input.siblingIndex],
    ["siblingCount", input.siblingCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`dispatch.${field} must be a non-negative safe integer.`);
    }
  }
  if (input.siblingCount < 1 || input.siblingIndex >= input.siblingCount) {
    throw new TypeError("Descendant sibling coordinates are invalid.");
  }
  if (
    (input.requestedForm === "single" &&
      (input.siblingCount !== 1 || input.siblingIndex !== 0)) ||
    (input.requestedForm === "concurrent_sibling" && input.siblingCount < 2)
  ) {
    throw new TypeError("Descendant dispatch form and sibling coordinates disagree.");
  }
  return Object.freeze({ ...input });
}
