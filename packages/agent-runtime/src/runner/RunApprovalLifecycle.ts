import type {
  ApprovalRecord,
  ValidatedApprovalDecision,
} from "@agent-anything/permission";
import type {
  PendingApproval,
  RunPermissionState,
} from "@agent-anything/agent-core/run";

export type ApprovalSettlementCounterEffect =
  | "applied"
  | "declined"
  | "review_failure"
  | "neutral";

export function beginApprovalReview(input: {
  readonly permission: RunPermissionState;
  readonly pending: PendingApproval & { readonly phase: "reviewing" };
}): RunPermissionState {
  if (input.permission.pendingApproval !== null) {
    throw new TypeError("A Run cannot begin a second approval review.");
  }
  const fingerprint = input.pending.request.actionFingerprint;
  const prior = input.permission.counters.requestsByActionFingerprint.find(
    (entry) => entry.actionFingerprint === fingerprint,
  );
  const requestsByActionFingerprint = prior === undefined
    ? [
        ...input.permission.counters.requestsByActionFingerprint,
        Object.freeze({ actionFingerprint: fingerprint, count: 1 }),
      ]
    : input.permission.counters.requestsByActionFingerprint.map((entry) =>
        entry.actionFingerprint === fingerprint
          ? Object.freeze({ ...entry, count: entry.count + 1 })
          : entry
      );
  return Object.freeze({
    ...input.permission,
    pendingApproval: input.pending,
    counters: Object.freeze({
      ...input.permission.counters,
      totalRequests: input.permission.counters.totalRequests + 1,
      requestsByActionFingerprint: Object.freeze(requestsByActionFingerprint),
      lastPendingVersion: input.pending.version,
    }),
  });
}

export function beginApprovalAuthorityApplication(input: {
  readonly permission: RunPermissionState;
  readonly decision: ValidatedApprovalDecision;
  readonly authorityOperationId: string;
}): RunPermissionState {
  const pending = requireReviewing(input.permission);
  return Object.freeze({
    ...input.permission,
    pendingApproval: Object.freeze({
      ...pending,
      phase: "applying_authority" as const,
      validatedDecision: input.decision,
      authorityOperationId: input.authorityOperationId,
    }),
  });
}

export function settleApproval(input: {
  readonly permission: RunPermissionState;
  readonly record: ApprovalRecord;
  readonly counterEffect: ApprovalSettlementCounterEffect;
}): RunPermissionState & { readonly pendingApproval: null } {
  const pending = input.permission.pendingApproval;
  if (pending === null) {
    throw new TypeError("Cannot settle approval without PendingApproval.");
  }
  if (
    input.record.runId !== pending.request.runId ||
    input.record.requestId !== pending.request.id ||
    input.record.actionId !== pending.request.actionId ||
    input.record.actionFingerprint !== pending.request.actionFingerprint ||
    input.record.pendingVersion !== pending.version ||
    input.record.reviewer !== pending.reviewer
  ) {
    throw new TypeError("ApprovalRecord does not match PendingApproval.");
  }
  if (input.permission.approvalRecords.some((record) => record.id === input.record.id)) {
    throw new TypeError(`ApprovalRecord id '${input.record.id}' is duplicated.`);
  }
  const counters = input.permission.counters;
  return Object.freeze({
    ...input.permission,
    pendingApproval: null,
    approvalRecords: Object.freeze([...input.permission.approvalRecords, input.record]),
    counters: Object.freeze({
      ...counters,
      consecutiveDeclines: input.counterEffect === "declined"
        ? counters.consecutiveDeclines + 1
        : input.counterEffect === "review_failure" || input.counterEffect === "applied"
          ? 0
          : counters.consecutiveDeclines,
      consecutiveReviewFailures: input.counterEffect === "review_failure"
        ? counters.consecutiveReviewFailures + 1
        : input.counterEffect === "declined" || input.counterEffect === "applied"
          ? 0
          : counters.consecutiveReviewFailures,
    }),
  });
}

function requireReviewing(
  permission: RunPermissionState,
): PendingApproval & { readonly phase: "reviewing" } {
  const pending = permission.pendingApproval;
  if (pending === null || pending.phase !== "reviewing") {
    throw new TypeError("Approval authority application requires a reviewing request.");
  }
  return pending;
}
