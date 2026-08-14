import {
  snapshotInteractionRequest,
  snapshotInteractionRequestRef,
  type InteractionProtocol,
  type InteractionProtocolRef,
  type InteractionRequestRef,
  type InteractionSubjectRef,
} from "@agent-anything/interaction/protocol";
import type { MaterializedPatchReview } from "../review/HelarcProposalWorkflow.js";

export const HELARC_PATCH_REVIEW_PROTOCOL: InteractionProtocolRef<"patch_review"> =
  Object.freeze({ owner: "helarc", kind: "patch_review", revision: "1" });

export interface HelarcPatchReviewPresentation {
  readonly runId: string;
  readonly proposalId: string;
  readonly proposalRevision: number;
  readonly reviewId: string;
  readonly rootName: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly operation: MaterializedPatchReview["operation"];
  readonly summary: string;
  readonly rationale: string;
  readonly originalContent: string | null;
  readonly proposedContent: string | null;
  readonly originalContentBytes: number | null;
  readonly proposedContentBytes: number | null;
}

export interface HelarcPatchReviewSubmission {
  readonly decision: "accepted" | "rejected" | "request_revision";
  readonly reason: string | null;
}

export interface HelarcPatchReviewResolution extends HelarcPatchReviewSubmission {
  readonly submissionId: string;
}

export interface HelarcPatchReviewApplication extends HelarcPatchReviewResolution {
  readonly kind: "helarc_patch_review_decision";
  readonly request: InteractionRequestRef<"patch_review">;
}

export type HelarcProductPhase =
  | { readonly kind: "none" }
  | {
      readonly kind: "patch_review_requested";
      readonly proposalId: string;
      readonly proposalRevision: number;
      readonly reviewId: string;
    }
  | {
      readonly kind: "patch_action_submitted";
      readonly proposalId: string;
      readonly proposalRevision: number;
      readonly reviewId: string;
      readonly requestVersion: number;
    };

export function createHelarcPatchReviewProtocol(): InteractionProtocol<
  "patch_review",
  HelarcPatchReviewPresentation,
  HelarcPatchReviewPresentation,
  HelarcPatchReviewSubmission,
  HelarcPatchReviewResolution,
  HelarcPatchReviewApplication
> {
  const protocol: InteractionProtocol<
    "patch_review",
    HelarcPatchReviewPresentation,
    HelarcPatchReviewPresentation,
    HelarcPatchReviewSubmission,
    HelarcPatchReviewResolution,
    HelarcPatchReviewApplication
  > = {
    ref: HELARC_PATCH_REVIEW_PROTOCOL,
    createRequest(input) {
      return snapshotInteractionRequest({
        ref: {
          id: input.requestId,
          protocol: HELARC_PATCH_REVIEW_PROTOCOL,
          requestVersion: input.requestVersion,
          subject: input.subjectRef,
        },
        subject: input.subject,
        correlation: input.correlation,
        parentRunAction: input.parentRunAction,
        presentation: input.presentation,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
      }, snapshotHelarcPatchReviewPresentation, snapshotHelarcPatchReviewPresentation);
    },
    validateSubmission(_request, candidate) {
      return snapshotHelarcPatchReviewSubmission(candidate);
    },
    resolve({ submissionId, submission }) {
      return Object.freeze({ submissionId, ...submission });
    },
    apply({ request, resolution }) {
      return Object.freeze({
        kind: "helarc_patch_review_decision" as const,
        request: snapshotInteractionRequestRef(request),
        submissionId: resolution.submissionId,
        decision: resolution.decision,
        reason: resolution.reason,
      });
    },
  };
  return Object.freeze(protocol);
}

export function createHelarcPatchReviewPresentation(
  review: MaterializedPatchReview,
): HelarcPatchReviewPresentation {
  return snapshotHelarcPatchReviewPresentation({
    runId: review.runId,
    proposalId: review.proposalId,
    proposalRevision: review.proposalRevision,
    reviewId: review.reviewId,
    rootName: review.rootName,
    workspaceId: review.workspaceId,
    path: review.path,
    operation: review.operation,
    summary: review.summary,
    rationale: review.rationale,
    originalContent: review.originalContent,
    proposedContent: review.proposedContent,
    originalContentBytes: review.originalContentBytes,
    proposedContentBytes: review.proposedContentBytes,
  });
}

export function createHelarcPatchReviewSubjectRef(
  review: MaterializedPatchReview,
): InteractionSubjectRef<"patch_proposal"> {
  return Object.freeze({
    owner: "helarc",
    kind: "patch_proposal",
    id: identity(review.reviewId, "reviewId"),
    revision: String(positiveInteger(review.proposalRevision, "proposalRevision")),
  });
}

export function snapshotHelarcPatchReviewPresentation(
  candidate: HelarcPatchReviewPresentation,
): HelarcPatchReviewPresentation {
  strictRecord(candidate, [
    "runId",
    "proposalId",
    "proposalRevision",
    "reviewId",
    "rootName",
    "workspaceId",
    "path",
    "operation",
    "summary",
    "rationale",
    "originalContent",
    "proposedContent",
    "originalContentBytes",
    "proposedContentBytes",
  ], "Patch review presentation");
  const operation = candidate.operation;
  if (operation !== "create" && operation !== "update" && operation !== "delete") {
    throw new TypeError("Patch review operation is invalid.");
  }
  return Object.freeze({
    runId: identity(candidate.runId, "runId"),
    proposalId: identity(candidate.proposalId, "proposalId"),
    proposalRevision: positiveInteger(candidate.proposalRevision, "proposalRevision"),
    reviewId: identity(candidate.reviewId, "reviewId"),
    rootName: boundedText(candidate.rootName, "rootName", 512, false),
    workspaceId: identity(candidate.workspaceId, "workspaceId"),
    path: boundedText(candidate.path, "path", 4_096, false),
    operation,
    summary: boundedText(candidate.summary, "summary", 4_096, false),
    rationale: boundedText(candidate.rationale, "rationale", 8_192, false),
    originalContent: nullableText(candidate.originalContent, "originalContent", 1_000_000),
    proposedContent: nullableText(candidate.proposedContent, "proposedContent", 1_000_000),
    originalContentBytes: nullableByteLength(candidate.originalContentBytes, "originalContentBytes"),
    proposedContentBytes: nullableByteLength(candidate.proposedContentBytes, "proposedContentBytes"),
  });
}

export function snapshotHelarcPatchReviewSubmission(
  candidate: unknown,
): HelarcPatchReviewSubmission {
  strictRecord(candidate, ["decision", "reason"], "Patch review submission");
  const decision = candidate.decision;
  if (decision !== "accepted" && decision !== "rejected" && decision !== "request_revision") {
    throw new TypeError("Patch review decision is invalid.");
  }
  const reason = nullableText(candidate.reason, "reason", 4_000);
  if (decision !== "accepted" && (reason === null || reason.trim().length === 0)) {
    throw new TypeError("Rejected or revision-requested patch review requires a reason.");
  }
  return Object.freeze({ decision, reason });
}

function strictRecord(
  candidate: unknown,
  expectedFields: readonly string[],
  label: string,
): asserts candidate is Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const actual = Object.keys(candidate).sort();
  const expected = [...expectedFields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError(`${label} contains unsupported fields.`);
  }
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) {
    throw new TypeError(`Patch review ${field} must be an identity.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`Patch review ${field} must be a positive integer.`);
  }
  return value as number;
}

function boundedText(
  value: unknown,
  field: string,
  maxLength: number,
  allowEmpty: boolean,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > maxLength
  ) {
    throw new TypeError(`Patch review ${field} is invalid.`);
  }
  return value;
}

function nullableText(value: unknown, field: string, maxLength: number): string | null {
  if (value === null) return null;
  return boundedText(value, field, maxLength, true);
}

function nullableByteLength(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Patch review ${field} must be a non-negative integer or null.`);
  }
  return value as number;
}
