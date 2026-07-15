import type {
  ApprovalApplicationOutcome,
  ApprovalCategory,
  ApprovalDecisionKind,
  ApprovalRecord,
  ApprovalRequest,
  ApprovalsReviewer,
} from "@agent-anything/permission";
import type { ISODateTimeString } from "@agent-anything/shared";

export interface ApprovalRequestSummary {
  readonly requestId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly category: ApprovalCategory;
  readonly reason: string;
  readonly optionIds: readonly [string, ...string[]];
  readonly createdAt: ISODateTimeString;
  readonly deadlineAt: ISODateTimeString;
}

export interface ApprovalRecordSummary {
  readonly recordId: string;
  readonly requestId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly pendingVersion: number;
  readonly reviewer: ApprovalsReviewer;
  readonly resolutionKind: ApprovalRecord["resolution"]["kind"];
  readonly decisionKind: ApprovalDecisionKind | null;
  readonly applicationKind: ApprovalApplicationOutcome["kind"];
  readonly authorityRecordIds: readonly string[];
  readonly code: string | null;
  readonly resolvedAt: ISODateTimeString;
}

export function createApprovalRequestSummary(
  request: ApprovalRequest,
): ApprovalRequestSummary {
  const optionIds = request.decisionOptions.map((option) => option.id) as [
    string,
    ...string[],
  ];
  return Object.freeze({
    requestId: request.id,
    actionId: request.actionId,
    actionFingerprint: request.actionFingerprint,
    category: request.category,
    reason: request.reason,
    optionIds: Object.freeze(optionIds),
    createdAt: request.createdAt,
    deadlineAt: request.deadlineAt,
  });
}

export function createApprovalRecordSummary(
  record: ApprovalRecord,
): ApprovalRecordSummary {
  return Object.freeze({
    recordId: record.id,
    requestId: record.requestId,
    actionId: record.actionId,
    actionFingerprint: record.actionFingerprint,
    pendingVersion: record.pendingVersion,
    reviewer: record.reviewer,
    resolutionKind: record.resolution.kind,
    decisionKind: record.resolution.kind === "decision"
      ? record.resolution.decision.kind
      : null,
    applicationKind: record.application.kind,
    authorityRecordIds: Object.freeze(applicationAuthorityRecordIds(record.application)),
    code: resolutionCode(record),
    resolvedAt: record.resolvedAt,
  });
}

function applicationAuthorityRecordIds(
  application: ApprovalApplicationOutcome,
): string[] {
  return application.kind === "applied"
    ? [...application.authorityRecordIds]
    : [];
}

function resolutionCode(record: ApprovalRecord): string | null {
  if (record.resolution.kind === "review_failure") {
    return record.resolution.failure.code;
  }
  if (record.resolution.kind === "run_cancelled") {
    return "runtime_cancelled";
  }
  if (
    record.application.kind === "not_applied" ||
    record.application.kind === "outcome_unknown"
  ) {
    return record.application.code;
  }
  return null;
}
