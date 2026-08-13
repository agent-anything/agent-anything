import type {
  InteractionApplyInput,
  InteractionCreateInput,
  InteractionProtocol,
  InteractionProtocolRef,
  InteractionRequest,
  InteractionRequestRef,
  InteractionResolveInput,
} from "@agent-anything/interaction/protocol";
import {
  snapshotInteractionProtocolRef,
  snapshotInteractionRequest,
} from "@agent-anything/interaction/protocol";
import type {
  ApprovalApplicationOutcome,
  ApprovalDecisionSubmission,
  ApprovalRequirement,
  ApprovalReviewRequest,
  ValidatedApprovalDecision,
} from "./ApprovalContracts.js";
import { projectApprovalReviewRequest } from "./projectApprovalReviewRequest.js";
import { snapshotApprovalDecisionSubmission } from "./ApprovalSnapshots.js";

export const APPROVAL_INTERACTION_PROTOCOL: InteractionProtocolRef<"approval"> =
  Object.freeze({ owner: "permission", kind: "approval", revision: "1" });

export interface ApprovalInteractionSubject {
  readonly requirement: ApprovalRequirement;
  readonly pendingVersion: number;
  readonly createdAt: string;
}

export interface ApprovalInteractionResolution {
  readonly resolutionId: string;
  readonly decision: ValidatedApprovalDecision;
}

export interface ApprovalInteractionHandlers {
  validateDecision(
    subject: ApprovalInteractionSubject,
    submission: ApprovalDecisionSubmission,
    request: InteractionRequestRef<"approval">,
  ): ValidatedApprovalDecision;
  applyDecision(
    subject: ApprovalInteractionSubject,
    resolution: ApprovalInteractionResolution,
    request: InteractionRequestRef<"approval">,
  ): ApprovalApplicationOutcome | Promise<ApprovalApplicationOutcome>;
}

export type ApprovalInteractionProtocol = InteractionProtocol<
  "approval",
  ApprovalInteractionSubject,
  ApprovalReviewRequest,
  ApprovalDecisionSubmission,
  ApprovalInteractionResolution,
  ApprovalApplicationOutcome
>;

export function createApprovalInteractionProtocol(
  handlers: ApprovalInteractionHandlers,
): ApprovalInteractionProtocol {
  const subjects = new Map<string, ApprovalInteractionSubject>();
  const requests = new Map<string, InteractionRequest<
    "approval",
    ApprovalInteractionSubject,
    ApprovalReviewRequest
  >>();

  return Object.freeze({
    ref: snapshotInteractionProtocolRef(APPROVAL_INTERACTION_PROTOCOL),
    createRequest(input: InteractionCreateInput<
      ApprovalInteractionSubject,
      ApprovalReviewRequest
    >) {
      if (input.subject.pendingVersion !== input.requestVersion) {
        throw new TypeError(
          "Approval pending version must equal Interaction request version.",
        );
      }
      if (
        input.subjectRef.owner !== "permission" ||
        input.subjectRef.kind !== "approval" ||
        input.subjectRef.id !== input.subject.requirement.subject.actionId ||
        input.subjectRef.revision !==
          input.subject.requirement.subject.actionFingerprint
      ) {
        throw new TypeError(
          "Approval Interaction must bind the exact canonical Action subject revision.",
        );
      }
      const request = snapshotInteractionRequest({
        ref: {
          id: input.requestId,
          protocol: APPROVAL_INTERACTION_PROTOCOL,
          requestVersion: input.requestVersion,
          subject: input.subjectRef,
        },
        subject: input.subject,
        correlation: input.correlation,
        parentRunAction: input.parentRunAction,
        presentation: input.presentation,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
      }, snapshotApprovalSubject, (presentation) => presentation);
      const key = requestKey(request.ref.id, request.ref.requestVersion);
      subjects.set(key, request.subject);
      requests.set(key, request);
      return request;
    },
    validateSubmission(
      request: InteractionRequestRef<"approval">,
      candidate: unknown,
    ) {
      const subject = requireSubject(subjects, request.id, request.requestVersion);
      const submission = snapshotApprovalDecisionSubmission(
        candidate as ApprovalDecisionSubmission,
      );
      if (
        submission.requestId !== request.id ||
        submission.pendingVersion !== subject.pendingVersion ||
        submission.runId !== subject.requirement.subject.runId
      ) {
        throw new TypeError("Approval submission does not match the pending Interaction.");
      }
      return submission;
    },
    resolve(input: InteractionResolveInput<"approval", ApprovalDecisionSubmission>) {
      const subject = requireSubject(
        subjects,
        input.request.id,
        input.request.requestVersion,
      );
      const decision = handlers.validateDecision(
        subject,
        input.submission,
        input.request,
      );
      return Object.freeze({
        resolutionId: `approval-resolution:${input.submissionId}`,
        decision,
      });
    },
    apply(input: InteractionApplyInput<"approval", ApprovalInteractionResolution>) {
      const subject = requireSubject(
        subjects,
        input.request.id,
        input.request.requestVersion,
      );
      return handlers.applyDecision(subject, input.resolution, input.request);
    },
  });
}

export function createApprovalInteractionPresentation(input: {
  readonly requestId: string;
  readonly requirement: ApprovalRequirement;
  readonly createdAt: string;
}): ApprovalReviewRequest {
  return projectApprovalReviewRequest({
    ...input.requirement,
    id: input.requestId,
    runId: input.requirement.subject.runId,
    actionId: input.requirement.subject.actionId,
    actionFingerprint: input.requirement.subject.actionFingerprint,
    createdAt: input.createdAt,
  } as import("./ApprovalContracts.js").ApprovalRequest);
}

function snapshotApprovalSubject(
  input: ApprovalInteractionSubject,
): ApprovalInteractionSubject {
  if (!Number.isSafeInteger(input.pendingVersion) || input.pendingVersion < 1) {
    throw new TypeError("Approval Interaction pending version must be positive.");
  }
  return Object.freeze({
    requirement: input.requirement,
    pendingVersion: input.pendingVersion,
    createdAt: input.createdAt,
  });
}

function requireSubject(
  subjects: ReadonlyMap<string, ApprovalInteractionSubject>,
  requestId: string,
  requestVersion: number,
): ApprovalInteractionSubject {
  const subject = subjects.get(requestKey(requestId, requestVersion));
  if (subject === undefined) {
    throw new TypeError("Approval Interaction request is unknown to this protocol instance.");
  }
  return subject;
}

function requestKey(requestId: string, requestVersion: number): string {
  return `${requestId}:${requestVersion}`;
}
