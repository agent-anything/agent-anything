import type { CancellationContext } from "@agent-anything/agent-core";
import type {
  HelarcPatchReviewBridge,
  HelarcPatchReviewDecisionSubmission,
  HelarcPatchReviewOutcome,
  HelarcPatchReviewProjectionListener,
  HelarcPatchReviewRequest,
  HelarcPatchReviewSubmissionReceipt,
  HelarcPendingPatchReviewProjection,
} from "@agent-anything/helarc";

export interface CreateHelarcPatchReviewBridgeInput {
  readonly runId: string;
  readonly onProjectionChanged?: HelarcPatchReviewProjectionListener;
}

interface ActivePatchReview {
  projection: HelarcPendingPatchReviewProjection;
  settled: boolean;
  resolve(outcome: HelarcPatchReviewOutcome): void;
  removeCancellationListener(): void;
}

interface SubmissionLedgerEntry {
  readonly submission: HelarcPatchReviewDecisionSubmission;
  readonly receipt: HelarcPatchReviewSubmissionReceipt;
}

export function createHelarcPatchReviewBridge(
  input: CreateHelarcPatchReviewBridgeInput,
): HelarcPatchReviewBridge {
  return new DefaultHelarcPatchReviewBridge(input);
}

class DefaultHelarcPatchReviewBridge implements HelarcPatchReviewBridge {
  readonly runId: string;
  private readonly listeners = new Set<HelarcPatchReviewProjectionListener>();
  private readonly submissions = new Map<string, SubmissionLedgerEntry>();
  private readonly closedReviews = new Set<string>();
  private active: ActivePatchReview | null = null;
  private nextPendingVersion = 1;
  private notificationQueue: Promise<void> = Promise.resolve();

  constructor(input: CreateHelarcPatchReviewBridgeInput) {
    this.runId = requireIdentity(input.runId, "Patch review bridge Run id");
    if (input.onProjectionChanged !== undefined) {
      this.listeners.add(input.onProjectionChanged);
    }
  }

  getPendingProjection(): HelarcPendingPatchReviewProjection | null {
    return this.active?.projection ?? null;
  }

  subscribe(listener: HelarcPatchReviewProjectionListener): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("Patch review projection listener must be a function.");
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async review(
    candidate: HelarcPatchReviewRequest,
    cancellation: CancellationContext,
  ): Promise<HelarcPatchReviewOutcome> {
    let request: HelarcPatchReviewRequest;
    try {
      request = snapshotReviewRequest(candidate);
    } catch {
      return failedOutcome("patch_review_state_invalid", "Patch review request is invalid.");
    }
    if (request.runId !== this.runId || cancellation.runId !== this.runId) {
      return failedOutcome(
        "patch_review_state_invalid",
        "Patch review Run identity does not match the active Host Run.",
      );
    }
    if (this.closedReviews.has(reviewKey(request))) {
      return failedOutcome(
        "patch_review_state_invalid",
        "A closed patch review cannot be reopened.",
      );
    }
    if (this.active !== null) {
      return failedOutcome(
        "patch_review_unavailable",
        "Another patch review is already pending for this Run.",
      );
    }
    if (cancellation.signal.aborted) {
      return interruptedOutcome(cancellation);
    }

    const projection = snapshotProjection({
      ...request,
      pendingVersion: this.nextPendingVersion,
      phase: "reviewing",
    });
    this.nextPendingVersion += 1;

    const outcome = await new Promise<HelarcPatchReviewOutcome>((resolve) => {
      const onCancelled = () => {
        const active = this.active;
        if (active === null || active.projection.reviewId !== projection.reviewId || active.settled) {
          return;
        }
        active.settled = true;
        resolve(interruptedOutcome(cancellation));
      };
      cancellation.signal.addEventListener("abort", onCancelled, { once: true });
      this.active = {
        projection,
        settled: false,
        resolve,
        removeCancellationListener: () => {
          cancellation.signal.removeEventListener("abort", onCancelled);
        },
      };
      this.notify(projection);
    });

    this.closeReview(projection.reviewId);
    return outcome;
  }

  submitDecision(
    candidate: HelarcPatchReviewDecisionSubmission,
  ): HelarcPatchReviewSubmissionReceipt {
    const submissionId = readSubmissionId(candidate);
    let submission: HelarcPatchReviewDecisionSubmission;
    try {
      submission = snapshotSubmission(candidate);
    } catch {
      return rejectedReceipt(submissionId, "patch_review_submission_invalid");
    }

    const previous = this.submissions.get(submission.submissionId);
    if (previous !== undefined) {
      return sameSubmission(previous.submission, submission)
        ? previous.receipt
        : rejectedReceipt(submission.submissionId, "patch_review_submission_invalid");
    }

    const active = this.active;
    if (active === null) {
      return rejectedReceipt(
        submission.submissionId,
        this.closedReviews.has(reviewKey(submission))
          ? "patch_review_already_resolved"
          : "patch_review_not_pending",
      );
    }
    const projection = active.projection;
    if (
      active.settled ||
      submission.runId !== this.runId ||
      submission.proposalId !== projection.proposalId ||
      submission.reviewId !== projection.reviewId
    ) {
      return rejectedReceipt(submission.submissionId, "patch_review_not_pending");
    }
    if (submission.pendingVersion !== projection.pendingVersion) {
      return rejectedReceipt(submission.submissionId, "patch_review_version_mismatch");
    }

    const receipt: HelarcPatchReviewSubmissionReceipt = Object.freeze({
      status: "accepted_for_resolution",
      submissionId: submission.submissionId,
      runId: submission.runId,
      proposalId: submission.proposalId,
      reviewId: submission.reviewId,
      pendingVersion: submission.pendingVersion,
    });
    this.submissions.set(submission.submissionId, { submission, receipt });
    active.settled = true;
    active.projection = snapshotProjection({
      ...projection,
      phase: "submitted_for_resolution",
    });
    this.notify(active.projection);
    active.resolve(Object.freeze({ status: "decided", submission }));
    return receipt;
  }

  private notify(projection: HelarcPendingPatchReviewProjection | null): void {
    const listeners = [...this.listeners];
    this.notificationQueue = this.notificationQueue.then(async () => {
      for (const listener of listeners) {
        try {
          await listener(projection);
        } catch {
          // Projection delivery is non-authoritative; the pending Promise remains canonical.
        }
      }
    });
  }

  private closeReview(reviewId: string): void {
    const active = this.active;
    if (active === null || active.projection.reviewId !== reviewId) return;
    active.removeCancellationListener();
    this.closedReviews.add(reviewKey(active.projection));
    this.active = null;
    this.notify(null);
  }
}

function snapshotReviewRequest(candidate: HelarcPatchReviewRequest): HelarcPatchReviewRequest {
  if (candidate === null || typeof candidate !== "object") {
    throw new TypeError("Patch review request must be an object.");
  }
  return Object.freeze({
    runId: requireIdentity(candidate.runId, "runId"),
    proposalId: requireIdentity(candidate.proposalId, "proposalId"),
    reviewId: requireIdentity(candidate.reviewId, "reviewId"),
    rootName: requireIdentity(candidate.rootName, "rootName"),
    workspaceId: requireIdentity(candidate.workspaceId, "workspaceId"),
    path: requireIdentity(candidate.path, "path"),
    operation: requireOperation(candidate.operation),
    summary: requireIdentity(candidate.summary, "summary"),
    rationale: requireIdentity(candidate.rationale, "rationale"),
    originalContent: optionalContent(candidate.originalContent, "originalContent"),
    proposedContent: optionalContent(candidate.proposedContent, "proposedContent"),
    originalContentBytes: optionalByteLength(
      candidate.originalContentBytes,
      "originalContentBytes",
    ),
    proposedContentBytes: optionalByteLength(
      candidate.proposedContentBytes,
      "proposedContentBytes",
    ),
  });
}

function snapshotProjection(
  candidate: HelarcPendingPatchReviewProjection,
): HelarcPendingPatchReviewProjection {
  const request = snapshotReviewRequest(candidate);
  if (!Number.isSafeInteger(candidate.pendingVersion) || candidate.pendingVersion < 1) {
    throw new TypeError("Patch review pendingVersion must be a positive integer.");
  }
  if (candidate.phase !== "reviewing" && candidate.phase !== "submitted_for_resolution") {
    throw new TypeError("Patch review phase is invalid.");
  }
  return Object.freeze({
    ...request,
    pendingVersion: candidate.pendingVersion,
    phase: candidate.phase,
  });
}

function snapshotSubmission(
  candidate: HelarcPatchReviewDecisionSubmission,
): HelarcPatchReviewDecisionSubmission {
  if (candidate === null || typeof candidate !== "object") {
    throw new TypeError("Patch review submission must be an object.");
  }
  const decision = candidate.decision;
  if (decision !== "accepted" && decision !== "rejected") {
    throw new TypeError("Patch review decision is invalid.");
  }
  if (!Number.isSafeInteger(candidate.pendingVersion) || candidate.pendingVersion < 1) {
    throw new TypeError("Patch review pendingVersion must be a positive integer.");
  }
  const reason = candidate.reason === null ? null : requireIdentity(candidate.reason, "reason");
  if (decision === "rejected" && reason === null) {
    throw new TypeError("Rejected patch review requires a reason.");
  }
  return Object.freeze({
    submissionId: requireIdentity(candidate.submissionId, "submissionId"),
    runId: requireIdentity(candidate.runId, "runId"),
    proposalId: requireIdentity(candidate.proposalId, "proposalId"),
    reviewId: requireIdentity(candidate.reviewId, "reviewId"),
    pendingVersion: candidate.pendingVersion,
    decision,
    reason,
  });
}

function interruptedOutcome(cancellation: CancellationContext): HelarcPatchReviewOutcome {
  return Object.freeze({
    status: "interrupted",
    cancellationRequestId: cancellation.request?.id ?? `${cancellation.runId}:cancellation`,
  });
}

function failedOutcome(
  code: Extract<HelarcPatchReviewOutcome, { status: "failed" }>["code"],
  message: string,
): HelarcPatchReviewOutcome {
  return Object.freeze({ status: "failed", code, message });
}

function rejectedReceipt(
  submissionId: string,
  code: Extract<HelarcPatchReviewSubmissionReceipt, { status: "rejected" }>["code"],
): HelarcPatchReviewSubmissionReceipt {
  return Object.freeze({ status: "rejected", submissionId, code });
}

function sameSubmission(
  left: HelarcPatchReviewDecisionSubmission,
  right: HelarcPatchReviewDecisionSubmission,
): boolean {
  return left.submissionId === right.submissionId &&
    left.runId === right.runId &&
    left.proposalId === right.proposalId &&
    left.reviewId === right.reviewId &&
    left.pendingVersion === right.pendingVersion &&
    left.decision === right.decision &&
    left.reason === right.reason;
}

function reviewKey(input: { runId: string; proposalId: string; reviewId: string }): string {
  return `${input.runId}\u0000${input.proposalId}\u0000${input.reviewId}`;
}

function requireIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return value;
}

function requireOperation(value: unknown): "create" | "update" | "delete" {
  if (value !== "create" && value !== "update" && value !== "delete") {
    throw new TypeError("Patch review operation is invalid.");
  }
  return value;
}

function optionalContent(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== "string") {
    throw new TypeError(`${field} must be a string or null.`);
  }
  return value;
}

function optionalByteLength(value: unknown, field: string): number | null {
  if (value !== null && (!Number.isSafeInteger(value) || (value as number) < 0)) {
    throw new TypeError(`${field} must be a non-negative integer or null.`);
  }
  return value as number | null;
}

function readSubmissionId(value: unknown): string {
  return typeof value === "object" && value !== null &&
      typeof (value as { submissionId?: unknown }).submissionId === "string"
    ? (value as { submissionId: string }).submissionId
    : "";
}
