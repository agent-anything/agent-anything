export interface RunTreeApprovalLimits {
  readonly maxTotalRequests: number;
  readonly maxRequestsPerOperationFingerprint: number;
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
    const exhaustedCode = this.currentLimitCode(request.operationFingerprint);
    if (exhaustedCode !== null) {
      return Object.freeze({
        status: "limit_exceeded" as const,
        code: exhaustedCode,
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
      exhaustedCode: this.currentLimitCode(null),
    });
  }

  private currentLimitCode(
    operationFingerprint: string | null,
  ): RunTreeApprovalLimitCode | null {
    if (this.totalRequests >= this.limits.maxTotalRequests) {
      return "approval_tree_total_limit_exceeded";
    }
    if (
      operationFingerprint !== null &&
      (this.operationCounts.get(operationFingerprint) ?? 0) >=
        this.limits.maxRequestsPerOperationFingerprint
    ) {
      return "approval_tree_operation_limit_exceeded";
    }
    if (this.consecutiveDeclines >= this.limits.maxConsecutiveDeclines) {
      return "approval_tree_decline_limit_exceeded";
    }
    if (
      this.consecutiveReviewerFailures >=
      this.limits.maxConsecutiveReviewerFailures
    ) {
      return "approval_tree_reviewer_failure_limit_exceeded";
    }
    if (this.active.size >= this.limits.maxActiveReviews) {
      return "approval_tree_active_limit_exceeded";
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
    if (!Number.isSafeInteger(limits[field]) || limits[field] <= 0) {
      throw new TypeError(`RunTreeApprovalLimits.${field} must be a positive safe integer.`);
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
