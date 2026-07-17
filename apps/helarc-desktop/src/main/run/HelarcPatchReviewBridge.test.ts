import { createRunCancellationController } from "@agent-anything/agent-core";
import type {
  HelarcPatchReviewDecisionSubmission,
  HelarcPatchReviewRequest,
} from "@agent-anything/helarc";
import { describe, expect, it } from "vitest";
import { createHelarcPatchReviewBridge } from "./HelarcPatchReviewBridge.js";

describe("HelarcPatchReviewBridge", () => {
  it("keeps one immutable versioned projection and one idempotent decision", async () => {
    const bridge = createBridge();
    const cancellation = createCancellation();
    const pending = bridge.review(reviewRequest(), cancellation.context);
    await flushMicrotasks();

    const projection = bridge.getPendingProjection();
    expect(projection).toMatchObject({
      runId: "run-1",
      proposalId: "proposal-1",
      reviewId: "review-1",
      pendingVersion: 1,
      phase: "reviewing",
    });
    expect(bridge.getPendingProjection()).toBe(projection);
    expect(Object.isFrozen(projection)).toBe(true);

    const receipt = bridge.submitDecision(submission());
    expect(receipt).toMatchObject({
      status: "accepted_for_resolution",
      submissionId: "submission-1",
      pendingVersion: 1,
    });
    expect(bridge.getPendingProjection()).toMatchObject({
      reviewId: "review-1",
      phase: "submitted_for_resolution",
    });
    expect(bridge.submitDecision(submission())).toBe(receipt);
    expect(bridge.submitDecision(submission({ decision: "rejected", reason: "Conflict" })))
      .toMatchObject({ code: "patch_review_submission_invalid" });
    await expect(pending).resolves.toEqual({ status: "decided", submission: submission() });
    expect(bridge.getPendingProjection()).toBeNull();
    expect(bridge.submitDecision(submission({ submissionId: "submission-late" })))
      .toMatchObject({ code: "patch_review_already_resolved" });
    await expect(bridge.review(reviewRequest(), cancellation.context)).resolves.toEqual({
      status: "failed",
      code: "patch_review_state_invalid",
      message: "A closed patch review cannot be reopened.",
    });
  });

  it("rejects malformed, cross-Run, mismatched, and stale submissions", async () => {
    const bridge = createBridge();
    const pending = bridge.review(reviewRequest(), createCancellation().context);
    await flushMicrotasks();

    expect(bridge.submitDecision(submission({ submissionId: "", reason: null })))
      .toMatchObject({ code: "patch_review_submission_invalid" });
    expect(bridge.submitDecision(submission({
      submissionId: "cross-run",
      runId: "run-other",
    }))).toMatchObject({ code: "patch_review_not_pending" });
    expect(bridge.submitDecision(submission({
      submissionId: "wrong-proposal",
      proposalId: "proposal-other",
    }))).toMatchObject({ code: "patch_review_not_pending" });
    expect(bridge.submitDecision(submission({
      submissionId: "wrong-review",
      reviewId: "review-other",
    }))).toMatchObject({ code: "patch_review_not_pending" });
    expect(bridge.submitDecision(submission({
      submissionId: "stale-version",
      pendingVersion: 2,
    }))).toMatchObject({ code: "patch_review_version_mismatch" });

    bridge.submitDecision(submission());
    await pending;
  });

  it("closes cancellation atomically and rejects post-cancellation decisions", async () => {
    const bridge = createBridge();
    const cancellation = createCancellation();
    const projections: Array<string | null> = [];
    bridge.subscribe((projection) => {
      projections.push(projection?.phase ?? null);
    });
    const pending = bridge.review(reviewRequest(), cancellation.context);
    await flushMicrotasks();

    cancellation.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });
    await expect(pending).resolves.toEqual({
      status: "interrupted",
      cancellationRequestId: "run-1:cancellation",
    });
    await flushMicrotasks();

    expect(bridge.getPendingProjection()).toBeNull();
    expect(projections).toEqual(["reviewing", null]);
    expect(bridge.submitDecision(submission({ submissionId: "post-cancel" })))
      .toMatchObject({ code: "patch_review_already_resolved" });
  });

  it("rejects concurrent review without replacing the canonical pending review", async () => {
    const bridge = createBridge();
    const cancellation = createCancellation();
    const first = bridge.review(reviewRequest(), cancellation.context);
    await flushMicrotasks();

    await expect(bridge.review(
      reviewRequest({ proposalId: "proposal-2", reviewId: "review-2" }),
      cancellation.context,
    )).resolves.toMatchObject({
      status: "failed",
      code: "patch_review_unavailable",
    });
    expect(bridge.getPendingProjection()).toMatchObject({
      proposalId: "proposal-1",
      reviewId: "review-1",
      pendingVersion: 1,
    });

    bridge.submitDecision(submission());
    await first;
  });

  it("increments version only for a new review and not for refresh", async () => {
    const bridge = createBridge();
    const cancellation = createCancellation();
    const first = bridge.review(reviewRequest(), cancellation.context);
    await flushMicrotasks();
    expect(bridge.getPendingProjection()?.pendingVersion).toBe(1);
    expect(bridge.getPendingProjection()?.pendingVersion).toBe(1);
    bridge.submitDecision(submission());
    await first;

    const second = bridge.review(
      reviewRequest({ proposalId: "proposal-2", reviewId: "review-2" }),
      cancellation.context,
    );
    await flushMicrotasks();
    expect(bridge.getPendingProjection()).toMatchObject({
      proposalId: "proposal-2",
      reviewId: "review-2",
      pendingVersion: 2,
    });
    bridge.submitDecision(submission({
      submissionId: "submission-2",
      proposalId: "proposal-2",
      reviewId: "review-2",
      pendingVersion: 2,
    }));
    await second;
  });
});

function createBridge() {
  return createHelarcPatchReviewBridge({ runId: "run-1" });
}

function createCancellation() {
  return createRunCancellationController({
    runId: "run-1",
    now: () => "2026-07-17T00:00:00.000Z",
  });
}

function reviewRequest(
  overrides: Partial<HelarcPatchReviewRequest> = {},
): HelarcPatchReviewRequest {
  return {
    runId: "run-1",
    proposalId: "proposal-1",
    reviewId: "review-1",
    rootName: "root",
    workspaceId: "workspace-1",
    path: "src/file.ts",
    operation: "update",
    summary: "Update file",
    rationale: "Apply requested change.",
    originalContent: "before\n",
    proposedContent: "after\n",
    originalContentBytes: 7,
    proposedContentBytes: 6,
    ...overrides,
  };
}

function submission(
  overrides: Partial<HelarcPatchReviewDecisionSubmission> = {},
): HelarcPatchReviewDecisionSubmission {
  return {
    submissionId: "submission-1",
    runId: "run-1",
    proposalId: "proposal-1",
    reviewId: "review-1",
    pendingVersion: 1,
    decision: "accepted",
    reason: null,
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
