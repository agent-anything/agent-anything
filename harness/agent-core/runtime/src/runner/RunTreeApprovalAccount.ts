import type { OperationLimitFailureDetail } from "@agent-anything/operation-catalog/result";

export interface RunTreeApprovalAdmissionDetail extends OperationLimitFailureDetail {
  readonly kind: "capacity";
  readonly stage: "approval_admission";
  readonly scope: { readonly owner: "agent-runtime"; readonly kind: "run_tree" };
  readonly limit: {
    readonly name: "total_requests" | "equivalent_operation_requests" | "consecutive_declines" |
      "consecutive_reviewer_failures" | "active_reviews";
    readonly count: number;
    readonly maximum: number;
  };
}

const APPROVAL_QUOTA_LABELS = Object.freeze({
  total_requests: "total approval requests",
  equivalent_operation_requests: "approval requests for this equivalent operation",
  consecutive_declines: "consecutive declined reviews",
  consecutive_reviewer_failures: "consecutive reviewer failures",
  active_reviews: "active approval reviews",
});

export interface RunTreeApprovalLimits {
  readonly maxTotalRequests: number | null;
  readonly maxRequestsPerOperationFingerprint: number | null;
  readonly maxConsecutiveDeclines: number;
  readonly maxConsecutiveReviewerFailures: number;
  readonly maxActiveReviews: number;
}

export type RunTreeApprovalLimitCode =
  | "approval_tree_total_limit_exceeded"
  | "approval_tree_operation_limit_exceeded"
  | "approval_tree_decline_limit_exceeded"
  | "approval_tree_reviewer_failure_limit_exceeded"
  | "approval_tree_active_limit_exceeded";

export interface RunTreeApprovalAdmissionInput {
  readonly requestId: string;
  readonly runId: string;
  readonly actionId: string;
  readonly authorityRevision: string;
  readonly workspaceId: string | null;
  readonly environmentId: string;
  readonly operationFingerprint: string;
}

export type RunTreeApprovalAdmission =
  | {
      readonly status: "accepted";
      readonly requestId: string;
      readonly revision: number;
    }
  | {
      readonly status: "limit_exceeded";
      readonly code: RunTreeApprovalLimitCode;
      readonly detail: RunTreeApprovalAdmissionDetail;
      readonly revision: number;
    };

export type RunTreeApprovalSettlementKind =
  | "approved"
  | "declined"
  | "reviewer_failure"
  | "cancelled"
  | "expired"
  | "invalidated"
  | "request_failure"
  | "interrupted"
  | "outcome_unknown";

export interface RunTreeApprovalSnapshot {
  readonly limits: RunTreeApprovalLimits;
  readonly revision: number;
  readonly totalRequests: number;
  readonly activeReviews: number;
  readonly settledRequests: number;
  readonly uniqueOperationFingerprints: number;
  readonly maxEquivalentOperationRequests: number;
  readonly consecutiveDeclines: number;
  readonly consecutiveReviewerFailures: number;
  readonly exhaustedCode: RunTreeApprovalLimitCode | null;
}

interface ActiveApprovalRequest extends RunTreeApprovalAdmissionInput {}

export class RunTreeApprovalAccount {
  private readonly limits: RunTreeApprovalLimits;
  private readonly active = new Map<string, ActiveApprovalRequest>();
  private readonly seenRequestIds = new Set<string>();
  private readonly operationCounts = new Map<string, number>();
  private revision = 0;
  private totalRequests = 0;
  private settledRequests = 0;
  private consecutiveDeclines = 0;
  private consecutiveReviewerFailures = 0;

  constructor(limits: RunTreeApprovalLimits) {
    this.limits = snapshotRunTreeApprovalLimits(limits);
  }

  admit(input: RunTreeApprovalAdmissionInput): RunTreeApprovalAdmission {
    const request = snapshotAdmission(input);
    if (this.seenRequestIds.has(request.requestId)) {
      throw new TypeError(`Approval request '${request.requestId}' was already admitted.`);
    }
    const rejection = this.currentLimit(request.operationFingerprint);
    if (rejection !== null) {
      return Object.freeze({
        status: "limit_exceeded" as const,
        ...rejection,
        revision: this.revision,
      });
    }
    this.totalRequests += 1;
    this.operationCounts.set(
      request.operationFingerprint,
      (this.operationCounts.get(request.operationFingerprint) ?? 0) + 1,
    );
    this.seenRequestIds.add(request.requestId);
    this.active.set(request.requestId, request);
    this.revision += 1;
    return Object.freeze({
      status: "accepted" as const,
      requestId: request.requestId,
      revision: this.revision,
    });
  }

  settle(requestId: string, kind: RunTreeApprovalSettlementKind): RunTreeApprovalSnapshot {
    assertToken(requestId, "requestId");
    assertSettlementKind(kind);
    if (!this.active.delete(requestId)) {
      throw new TypeError(`Approval request '${requestId}' is not active.`);
    }
    this.settledRequests += 1;
    if (kind === "declined") {
      this.consecutiveDeclines += 1;
      this.consecutiveReviewerFailures = 0;
    } else if (kind === "reviewer_failure") {
      this.consecutiveReviewerFailures += 1;
      this.consecutiveDeclines = 0;
    } else {
      this.consecutiveDeclines = 0;
      this.consecutiveReviewerFailures = 0;
    }
    this.revision += 1;
    return this.getSnapshot();
  }

  getSnapshot(): RunTreeApprovalSnapshot {
    const counts = [...this.operationCounts.values()];
    return Object.freeze({
      limits: this.limits,
      revision: this.revision,
      totalRequests: this.totalRequests,
      activeReviews: this.active.size,
      settledRequests: this.settledRequests,
      uniqueOperationFingerprints: this.operationCounts.size,
      maxEquivalentOperationRequests: counts.length === 0 ? 0 : Math.max(...counts),
      consecutiveDeclines: this.consecutiveDeclines,
      consecutiveReviewerFailures: this.consecutiveReviewerFailures,
      exhaustedCode: this.currentLimit(null)?.code ?? null,
    });
  }

  private currentLimit(
    operationFingerprint: string | null,
  ): { readonly code: RunTreeApprovalLimitCode; readonly detail: RunTreeApprovalAdmissionDetail } | null {
    const rejection = (
      code: RunTreeApprovalLimitCode,
      name: RunTreeApprovalAdmissionDetail["limit"]["name"],
      count: number,
      limit: number,
    ) => Object.freeze({ code, detail: Object.freeze({
      kind: "capacity" as const, stage: "approval_admission" as const,
      scope: Object.freeze({owner: "agent-runtime" as const, kind: "run_tree" as const}),
      limit: Object.freeze({name, count, maximum: limit}),
      description: `Approval capacity reached for ${APPROVAL_QUOTA_LABELS[name]} across the whole run tree (${count}/${limit}). ` +
        "This admission rejection is not a user denial; the action was never dispatched." +
        (name === "total_requests" || name === "equivalent_operation_requests"
          ? " Retrying does not reset this cumulative quota."
          : name === "active_reviews" ? " Active review capacity is released when reviews settle." : ""),
      dispatch: "never_dispatched" as const,
    }) });
    if (this.limits.maxTotalRequests !== null && this.totalRequests >= this.limits.maxTotalRequests) {
      return rejection("approval_tree_total_limit_exceeded", "total_requests", this.totalRequests, this.limits.maxTotalRequests);
    }
    if (
      operationFingerprint !== null &&
      this.limits.maxRequestsPerOperationFingerprint !== null &&
      (this.operationCounts.get(operationFingerprint) ?? 0) >=
        this.limits.maxRequestsPerOperationFingerprint
    ) {
      return rejection("approval_tree_operation_limit_exceeded", "equivalent_operation_requests",
        this.operationCounts.get(operationFingerprint) ?? 0, this.limits.maxRequestsPerOperationFingerprint);
    }
    if (this.consecutiveDeclines >= this.limits.maxConsecutiveDeclines) {
      return rejection("approval_tree_decline_limit_exceeded", "consecutive_declines",
        this.consecutiveDeclines, this.limits.maxConsecutiveDeclines);
    }
    if (
      this.consecutiveReviewerFailures >=
      this.limits.maxConsecutiveReviewerFailures
    ) {
      return rejection("approval_tree_reviewer_failure_limit_exceeded", "consecutive_reviewer_failures",
        this.consecutiveReviewerFailures, this.limits.maxConsecutiveReviewerFailures);
    }
    if (this.active.size >= this.limits.maxActiveReviews) {
      return rejection("approval_tree_active_limit_exceeded", "active_reviews", this.active.size, this.limits.maxActiveReviews);
    }
    return null;
  }
}

export function snapshotRunTreeApprovalLimits(
  limits: RunTreeApprovalLimits,
): RunTreeApprovalLimits {
  if (limits === null || typeof limits !== "object") {
    throw new TypeError("RunTreeApprovalLimits must be an object.");
  }
  for (const field of [
    "maxTotalRequests",
    "maxRequestsPerOperationFingerprint",
    "maxConsecutiveDeclines",
    "maxConsecutiveReviewerFailures",
    "maxActiveReviews",
  ] as const) {
    const nullable = field === "maxTotalRequests" || field === "maxRequestsPerOperationFingerprint";
    const value = limits[field];
    if (nullable && value === null) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`RunTreeApprovalLimits.${field} must be a positive safe integer${nullable ? " or null" : ""}.`);
    }
  }
  return Object.freeze({ ...limits });
}

function snapshotAdmission(
  input: RunTreeApprovalAdmissionInput,
): RunTreeApprovalAdmissionInput {
  if (input === null || typeof input !== "object") {
    throw new TypeError("RunTreeApprovalAdmissionInput must be an object.");
  }
  for (const field of [
    "requestId",
    "runId",
    "actionId",
    "authorityRevision",
    "environmentId",
    "operationFingerprint",
  ] as const) {
    assertToken(input[field], field);
  }
  if (input.workspaceId !== null) assertToken(input.workspaceId, "workspaceId");
  return Object.freeze({ ...input });
}

function assertSettlementKind(kind: string): asserts kind is RunTreeApprovalSettlementKind {
  if (![
    "approved",
    "declined",
    "reviewer_failure",
    "cancelled",
    "expired",
    "invalidated",
    "request_failure",
    "interrupted",
    "outcome_unknown",
  ].includes(kind)) {
    throw new TypeError("Approval settlement kind is unsupported.");
  }
}

function assertToken(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty canonical string.`);
  }
}
