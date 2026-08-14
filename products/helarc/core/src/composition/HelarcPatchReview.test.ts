import { describe, expect, it } from "vitest";
import type { MaterializedPatchReview } from "../review/HelarcProposalWorkflow.js";
import {
  createHelarcPatchReviewPresentation,
  createHelarcPatchReviewProtocol,
  createHelarcPatchReviewSubjectRef,
  HELARC_PATCH_REVIEW_PROTOCOL,
} from "./HelarcPatchReview.js";

describe("Helarc Patch Review Interaction protocol", () => {
  it("carries the exact request reference and submission identity into application", async () => {
    const review = patchReview();
    const presentation = createHelarcPatchReviewPresentation(review);
    const protocol = createHelarcPatchReviewProtocol();
    const request = protocol.createRequest({
      requestId: "patch-review-request-1",
      requestVersion: 1,
      subject: presentation,
      subjectRef: createHelarcPatchReviewSubjectRef(review),
      correlation: {
        kind: "owner_operation",
        owner: "helarc",
        operationId: review.reviewId,
        operationRevision: "1",
      },
      parentRunAction: null,
      presentation,
      expiresAt: null,
      createdAt: "2026-08-14T00:00:00.000Z",
    });
    const submission = protocol.validateSubmission(request.ref, {
      decision: "accepted",
      reason: null,
    });
    const resolution = protocol.resolve({
      request: request.ref,
      submissionId: "submission-1",
      submission,
      receivedAt: "2026-08-14T00:00:01.000Z",
    });
    const application = await protocol.apply({
      request: request.ref,
      resolution,
      resolvedAt: "2026-08-14T00:00:02.000Z",
    });

    expect(request.ref).toEqual({
      id: "patch-review-request-1",
      protocol: HELARC_PATCH_REVIEW_PROTOCOL,
      requestVersion: 1,
      subject: {
        owner: "helarc",
        kind: "patch_proposal",
        id: "review-1",
        revision: "1",
      },
    });
    expect(application).toEqual({
      kind: "helarc_patch_review_decision",
      request: request.ref,
      submissionId: "submission-1",
      decision: "accepted",
      reason: null,
    });
    expect(Object.isFrozen(application)).toBe(true);
  });

  it("requires a bounded reason for rejection and revision requests", () => {
    const protocol = createHelarcPatchReviewProtocol();
    const request = {
      id: "patch-review-request-1",
      protocol: HELARC_PATCH_REVIEW_PROTOCOL,
      requestVersion: 1,
      subject: {
        owner: "helarc",
        kind: "patch_proposal",
        id: "review-1",
        revision: "1",
      },
    } as const;

    expect(() => protocol.validateSubmission(request, {
      decision: "rejected",
      reason: null,
    })).toThrow("requires a reason");
    expect(() => protocol.validateSubmission(request, {
      decision: "request_revision",
      reason: "",
    })).toThrow("requires a reason");
    expect(() => protocol.validateSubmission(request, {
      decision: "accepted",
      reason: null,
      authority: "filesystem-write",
    })).toThrow("unsupported fields");
  });
});

function patchReview(): MaterializedPatchReview {
  return {
    runId: "run-1",
    proposalId: "proposal-1",
    proposalRevision: 1,
    reviewId: "review-1",
    rootName: "Workspace",
    workspaceId: "workspace-1",
    path: "src/file.ts",
    operation: "update",
    summary: "Update file",
    rationale: "Apply the requested change.",
    originalContent: "before\n",
    proposedContent: "after\n",
    originalContentBytes: 7,
    proposedContentBytes: 6,
    metadata: {},
  };
}
