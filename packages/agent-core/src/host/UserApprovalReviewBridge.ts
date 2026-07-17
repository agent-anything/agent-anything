import {
  snapshotApprovalDecisionSubmission,
  snapshotApprovalInterruption,
  snapshotApprovalReviewerDescriptor,
  snapshotApprovalReviewInput,
  type ApprovalDecisionSubmission,
  type ApprovalReviewerDescriptor,
  type ApprovalReviewerPort,
  type ApprovalReviewInput,
  type ApprovalReviewOutcome,
  type ApprovalSubmissionReceipt,
} from "@agent-anything/permission";
import type { InvocationInterruptionContext } from "@agent-anything/shared";

export interface UserApprovalPendingProjection extends ApprovalReviewInput {}

export interface UserApprovalNotificationFailure {
  readonly code: "approval_notification_failed";
  readonly message: string;
  readonly runId: string;
  readonly requestId: string;
  readonly pendingVersion: number;
  readonly phase: "pending" | "cleared";
}

export interface CreateUserApprovalReviewBridgeInput {
  readonly runId: string;
  readonly descriptor: ApprovalReviewerDescriptor & { readonly kind: "user" };
  readonly onProjectionChanged?: (
    projection: UserApprovalPendingProjection | null,
  ) => void | Promise<void>;
  readonly onNotificationFailure?: (
    failure: UserApprovalNotificationFailure,
  ) => void | Promise<void>;
}

export type UserApprovalProjectionListener = (
  projection: UserApprovalPendingProjection | null,
) => void | Promise<void>;

export interface UserApprovalReviewBridge extends ApprovalReviewerPort {
  readonly runId: string;
  readonly descriptor: ApprovalReviewerDescriptor & { readonly kind: "user" };
  getPendingProjection(): UserApprovalPendingProjection | null;
  subscribe(listener: UserApprovalProjectionListener): () => void;
  submitDecision(
    submission: ApprovalDecisionSubmission,
  ): ApprovalSubmissionReceipt;
}

interface ActiveReview {
  readonly projection: UserApprovalPendingProjection;
  readonly interruption: InvocationInterruptionContext;
  readonly onAbort: () => void;
  readonly resolve: (outcome: ApprovalReviewOutcome) => void;
}

interface SubmissionLedgerEntry {
  readonly fingerprint: string;
  readonly receipt: Extract<
    ApprovalSubmissionReceipt,
    { readonly status: "accepted_for_resolution" }
  >;
}

export function createUserApprovalReviewBridge(
  input: CreateUserApprovalReviewBridgeInput,
): UserApprovalReviewBridge {
  return new DefaultUserApprovalReviewBridge(input);
}

class DefaultUserApprovalReviewBridge implements UserApprovalReviewBridge {
  readonly runId: string;
  readonly descriptor: ApprovalReviewerDescriptor & { readonly kind: "user" };
  private readonly onNotificationFailure: CreateUserApprovalReviewBridgeInput["onNotificationFailure"];
  private readonly projectionListeners = new Set<UserApprovalProjectionListener>();
  private readonly submissions = new Map<string, SubmissionLedgerEntry>();
  private readonly closedRequests = new Set<string>();
  private notificationQueue: Promise<void> = Promise.resolve();
  private active: ActiveReview | null = null;

  constructor(input: CreateUserApprovalReviewBridgeInput) {
    assertIdentity(input.runId, "User approval bridge runId");
    this.runId = input.runId;
    this.descriptor = snapshotApprovalReviewerDescriptor(
      input.descriptor,
      "user",
    ) as ApprovalReviewerDescriptor & { readonly kind: "user" };
    if (
      input.onProjectionChanged !== undefined &&
      typeof input.onProjectionChanged !== "function"
    ) {
      throw new TypeError("onProjectionChanged must be a function.");
    }
    if (
      input.onNotificationFailure !== undefined &&
      typeof input.onNotificationFailure !== "function"
    ) {
      throw new TypeError("onNotificationFailure must be a function.");
    }
    if (input.onProjectionChanged !== undefined) {
      this.projectionListeners.add(input.onProjectionChanged);
    }
    this.onNotificationFailure = input.onNotificationFailure;
  }

  async review(
    candidate: ApprovalReviewInput,
    interruption: InvocationInterruptionContext,
  ): Promise<ApprovalReviewOutcome> {
    let projection: UserApprovalPendingProjection;
    try {
      projection = snapshotApprovalReviewInput(candidate);
    } catch {
      return failed(
        "approval_review_malformed",
        "User approval bridge received malformed review input.",
        false,
      );
    }
    if (projection.request.runId !== this.runId) {
      return failed(
        "approval_review_malformed",
        "User approval bridge received a review for another Run.",
        false,
      );
    }
    if (this.active !== null) {
      return failed(
        "approval_reviewer_unavailable",
        "User approval bridge already has an active review.",
        false,
      );
    }
    const key = requestKey(
      projection.request.runId,
      projection.request.id,
      projection.pendingVersion,
    );
    if (this.closedRequests.has(key)) {
      return failed(
        "approval_reviewer_unavailable",
        "User approval review is already closed.",
        false,
      );
    }
    if (interruption.signal.aborted) {
      this.closedRequests.add(key);
      return interruptionOutcome(interruption, this.runId);
    }

    return new Promise<ApprovalReviewOutcome>((resolve) => {
      const onAbort = (): void => {
        const active = this.active;
        if (active === null || active.projection !== projection) return;
        this.settleActive(interruptionOutcome(interruption, this.runId));
      };
      this.active = {
        projection,
        interruption,
        onAbort,
        resolve,
      };
      interruption.signal.addEventListener("abort", onAbort, { once: true });
      this.notifyProjection(projection, "pending");
      if (interruption.signal.aborted) onAbort();
    });
  }

  getPendingProjection(): UserApprovalPendingProjection | null {
    return this.active?.projection ?? null;
  }

  subscribe(listener: UserApprovalProjectionListener): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("User approval projection listener must be a function.");
    }
    this.projectionListeners.add(listener);
    return () => {
      this.projectionListeners.delete(listener);
    };
  }

  submitDecision(
    candidate: ApprovalDecisionSubmission,
  ): ApprovalSubmissionReceipt {
    const rawSubmissionId = submissionId(candidate);
    let submission: ApprovalDecisionSubmission;
    try {
      submission = snapshotApprovalDecisionSubmission(candidate);
    } catch {
      return rejected(rawSubmissionId, "approval_submission_invalid");
    }

    const fingerprint = JSON.stringify(submission);
    const prior = this.submissions.get(submission.submissionId);
    if (prior !== undefined) {
      return prior.fingerprint === fingerprint
        ? prior.receipt
        : rejected(submission.submissionId, "approval_submission_invalid");
    }

    const key = requestKey(
      submission.runId,
      submission.requestId,
      submission.pendingVersion,
    );
    if (this.closedRequests.has(key)) {
      return rejected(submission.submissionId, "approval_already_resolved");
    }

    const active = this.active;
    if (
      active === null ||
      submission.runId !== this.runId ||
      submission.requestId !== active.projection.request.id
    ) {
      return rejected(submission.submissionId, "approval_not_pending");
    }
    if (submission.pendingVersion !== active.projection.pendingVersion) {
      return rejected(submission.submissionId, "approval_version_mismatch");
    }

    const receipt = Object.freeze({
      status: "accepted_for_resolution" as const,
      submissionId: submission.submissionId,
      runId: submission.runId,
      requestId: submission.requestId,
      pendingVersion: submission.pendingVersion,
    });
    this.submissions.set(submission.submissionId, { fingerprint, receipt });
    this.settleActive(Object.freeze({
      status: "decided",
      submission,
      rationale: submission.reason,
    }));
    return receipt;
  }

  private settleActive(outcome: ApprovalReviewOutcome): void {
    const active = this.active;
    if (active === null) return;
    this.active = null;
    active.interruption.signal.removeEventListener("abort", active.onAbort);
    this.closedRequests.add(requestKey(
      active.projection.request.runId,
      active.projection.request.id,
      active.projection.pendingVersion,
    ));
    this.notifyProjection(null, "cleared", active.projection);
    active.resolve(outcome);
  }

  private notifyProjection(
    projection: UserApprovalPendingProjection | null,
    phase: UserApprovalNotificationFailure["phase"],
    previous: UserApprovalPendingProjection | null = projection,
  ): void {
    if (this.projectionListeners.size === 0) return;
    const correlation = previous ?? projection;
    if (correlation === null) return;
    const listeners = [...this.projectionListeners];
    this.notificationQueue = this.notificationQueue
      .then(async () => {
        for (const listener of listeners) {
          try {
            await listener(projection);
          } catch {
            await this.reportNotificationFailure(Object.freeze({
              code: "approval_notification_failed" as const,
              message: "User approval projection notification failed.",
              runId: correlation.request.runId,
              requestId: correlation.request.id,
              pendingVersion: correlation.pendingVersion,
              phase,
            }));
          }
        }
      });
  }

  private reportNotificationFailure(
    failure: UserApprovalNotificationFailure,
  ): Promise<void> {
    if (this.onNotificationFailure === undefined) return Promise.resolve();
    return Promise.resolve(this.onNotificationFailure(failure)).catch(() => undefined);
  }
}

function interruptionOutcome(
  context: InvocationInterruptionContext,
  expectedRunId: string,
): ApprovalReviewOutcome {
  try {
    if (!context.signal.aborted || context.interruption === null) {
      return failed(
        "approval_review_failed",
        "User approval bridge was interrupted without correlation.",
        false,
      );
    }
    const interruption = snapshotApprovalInterruption(context.interruption);
    if (
      interruption.kind === "run_cancellation" &&
      interruption.cancellation.runId !== expectedRunId
    ) {
      return failed(
        "approval_review_failed",
        "User approval bridge received cancellation for another Run.",
        false,
      );
    }
    return Object.freeze({ status: "interrupted", interruption });
  } catch {
    return failed(
      "approval_review_failed",
      "User approval bridge received malformed interruption correlation.",
      false,
    );
  }
}

function failed(
  code: "approval_reviewer_unavailable" | "approval_review_failed" | "approval_review_malformed",
  message: string,
  retryable: boolean,
): ApprovalReviewOutcome {
  return Object.freeze({
    status: "failed",
    failure: Object.freeze({
      code,
      message,
      retryable,
      metadata: Object.freeze({}),
    }),
  });
}

function rejected(
  submissionId: string,
  code: Extract<ApprovalSubmissionReceipt, { status: "rejected" }>["code"],
): ApprovalSubmissionReceipt {
  return Object.freeze({ status: "rejected", submissionId, code });
}

function submissionId(candidate: unknown): string {
  return typeof candidate === "object" && candidate !== null &&
      typeof (candidate as { submissionId?: unknown }).submissionId === "string"
    ? (candidate as { submissionId: string }).submissionId
    : "";
}

function requestKey(runId: string, requestId: string, pendingVersion: number): string {
  return `${runId}\u0000${requestId}\u0000${pendingVersion}`;
}

function assertIdentity(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) {
    throw new TypeError(`${field} must be a non-empty identity.`);
  }
}
