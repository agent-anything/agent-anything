import type { ISODateTimeString } from "@agent-anything/shared";

export type RetryOwner =
  | "provider_request"
  | "response_stream"
  | "approvals_reviewer"
  | "structured_output";

export interface RetryOperation {
  readonly operationId: string;
  readonly owner: RetryOwner;
  readonly runId: string;
  readonly subject: RetryOperationSubject;
  readonly startedAt: ISODateTimeString;
  readonly deadlineAt?: ISODateTimeString;
}

export type RetryOperationSubject =
  | {
      readonly kind: "provider_request";
      readonly controllerRequestId: string;
    }
  | {
      readonly kind: "response_stream";
      readonly controllerRequestId: string;
      readonly streamId: string;
    }
  | {
      readonly kind: "approval_review";
      readonly approvalRequestId: string;
    }
  | {
      readonly kind: "structured_output";
      readonly controllerRequestId: string;
      readonly contractId: string;
    };

export interface RetryAttempt {
  readonly attemptId: string;
  readonly operationId: string;
  readonly budgetId: string;
  readonly attemptNumber: number;
  readonly budgetAttemptNumber: number;
  readonly retryNumber: number;
  readonly maxBudgetAttempts: number;
  readonly startedAt: ISODateTimeString;
}

export function snapshotRetryOperation(operation: RetryOperation): RetryOperation {
  if (!isRecord(operation)) {
    throw new TypeError("RetryOperation must be an object.");
  }
  assertNonEmpty(operation.operationId, "RetryOperation.operationId");
  assertNonEmpty(operation.runId, "RetryOperation.runId");
  assertDateTime(operation.startedAt, "RetryOperation.startedAt");
  if (operation.deadlineAt !== undefined) {
    assertDateTime(operation.deadlineAt, "RetryOperation.deadlineAt");
    if (Date.parse(operation.deadlineAt) <= Date.parse(operation.startedAt)) {
      throw new TypeError("RetryOperation.deadlineAt must be later than startedAt.");
    }
  }
  validateSubject(operation.owner, operation.subject);

  return Object.freeze({
    operationId: operation.operationId,
    owner: operation.owner,
    runId: operation.runId,
    subject: snapshotSubject(operation.subject),
    startedAt: operation.startedAt,
    ...(operation.deadlineAt === undefined ? {} : { deadlineAt: operation.deadlineAt }),
  });
}

function snapshotSubject(subject: RetryOperationSubject): RetryOperationSubject {
  switch (subject.kind) {
    case "provider_request":
      return Object.freeze({
        kind: subject.kind,
        controllerRequestId: subject.controllerRequestId,
      });
    case "response_stream":
      return Object.freeze({
        kind: subject.kind,
        controllerRequestId: subject.controllerRequestId,
        streamId: subject.streamId,
      });
    case "approval_review":
      return Object.freeze({
        kind: subject.kind,
        approvalRequestId: subject.approvalRequestId,
      });
    case "structured_output":
      return Object.freeze({
        kind: subject.kind,
        controllerRequestId: subject.controllerRequestId,
        contractId: subject.contractId,
      });
  }
}

function validateSubject(owner: RetryOwner, subject: RetryOperationSubject): void {
  if (!isRecord(subject)) {
    throw new TypeError("RetryOperation.subject must be an object.");
  }
  const expectedKind = {
    provider_request: "provider_request",
    response_stream: "response_stream",
    approvals_reviewer: "approval_review",
    structured_output: "structured_output",
  }[owner];
  if (expectedKind === undefined || subject.kind !== expectedKind) {
    throw new TypeError(`RetryOperation owner ${owner} does not match subject kind.`);
  }

  switch (subject.kind) {
    case "provider_request":
      assertNonEmpty(subject.controllerRequestId, "RetryOperation.subject.controllerRequestId");
      break;
    case "response_stream":
      assertNonEmpty(subject.controllerRequestId, "RetryOperation.subject.controllerRequestId");
      assertNonEmpty(subject.streamId, "RetryOperation.subject.streamId");
      break;
    case "approval_review":
      assertNonEmpty(subject.approvalRequestId, "RetryOperation.subject.approvalRequestId");
      break;
    case "structured_output":
      assertNonEmpty(subject.controllerRequestId, "RetryOperation.subject.controllerRequestId");
      assertNonEmpty(subject.contractId, "RetryOperation.subject.contractId");
      break;
  }
}

function assertDateTime(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid date-time string.`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
