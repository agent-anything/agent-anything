import type { ISODateTimeString } from "@agent-anything/shared";

export type RunCancellationOrigin =
  | "user"
  | "host"
  | "approval"
  | "parent_run"
  | "runner";

export type RunCancellationReasonCode =
  | "user_requested"
  | "host_requested"
  | "host_shutdown"
  | "approval_cancelled"
  | "parent_run_cancelled"
  | "runner_shutdown";

export interface RunCancellationRequestInput {
  readonly origin: RunCancellationOrigin;
  readonly reasonCode: RunCancellationReasonCode;
  readonly reason?: string;
  readonly approvalRequestId?: string;
  readonly parentRunId?: string;
}

export interface RunCancellationRequest {
  readonly id: string;
  readonly runId: string;
  readonly origin: RunCancellationOrigin;
  readonly reasonCode: RunCancellationReasonCode;
  readonly reason: string | null;
  readonly approvalRequestId: string | null;
  readonly parentRunId: string | null;
  readonly requestedAt: ISODateTimeString;
}

export interface CancellationContext {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly request: RunCancellationRequest | null;
}

export interface RunCancellationReceipt {
  readonly accepted: boolean;
  readonly request: RunCancellationRequest;
}

export interface RunCancellationController {
  readonly context: CancellationContext;
  requestCancellation(input: RunCancellationRequestInput): RunCancellationReceipt;
}

export interface RunCancellationSummary {
  readonly requestId: string;
  readonly origin: RunCancellationOrigin;
  readonly reasonCode: RunCancellationReasonCode;
  readonly requestedAt: ISODateTimeString;
}

export type InterruptibleOperationKind =
  | "controller"
  | "provider"
  | "retry_wait"
  | "approval_reviewer"
  | "authority_commit"
  | "tool"
  | "process";

export interface CancellationAttribution {
  readonly requestId: string;
  readonly runId: string;
  readonly operation: InterruptibleOperationKind;
  readonly observedAt: ISODateTimeString;
}

export interface CancellationLimits {
  readonly operationSettlementTimeoutMs: number;
  readonly processGracePeriodMs: number;
  readonly processForceKillTimeoutMs: number;
  readonly finalizationTimeoutMs: number;
}

export interface RunFinalizationContext {
  readonly runId: string;
  readonly cancellation: RunCancellationSummary | null;
  readonly deadlineAt: ISODateTimeString;
  readonly signal: AbortSignal;
}

export type InterruptibleOperationResult<TValue, TFailure> =
  | { readonly kind: "succeeded"; readonly value: TValue }
  | { readonly kind: "failed"; readonly failure: TFailure }
  | {
      readonly kind: "cancelled";
      readonly attribution: CancellationAttribution;
    }
  | {
      readonly kind: "cancellation_unconfirmed";
      readonly operation: InterruptibleOperationKind;
      readonly message: string;
    };

export interface CreateRunCancellationControllerInput {
  readonly runId: string;
  readonly createRequestId?: (runId: string) => string;
  readonly now?: () => ISODateTimeString;
}

const originReasonCodes: Readonly<Record<RunCancellationOrigin, readonly RunCancellationReasonCode[]>> = {
  user: ["user_requested"],
  host: ["host_requested", "host_shutdown"],
  approval: ["approval_cancelled"],
  parent_run: ["parent_run_cancelled"],
  runner: ["runner_shutdown"],
};
const MAX_CANCELLATION_REASON_LENGTH = 500;

export function createRunCancellationController(
  input: CreateRunCancellationControllerInput,
): RunCancellationController {
  assertNonEmpty(input.runId, "runId");

  const abortController = new AbortController();
  let request: RunCancellationRequest | null = null;
  const context: CancellationContext = Object.freeze({
    runId: input.runId,
    signal: abortController.signal,
    get request() {
      return request;
    },
  });

  return Object.freeze({
    context,
    requestCancellation(requestInput: RunCancellationRequestInput) {
      if (request !== null) {
        return Object.freeze({ accepted: false, request });
      }

      validateRequestInput(requestInput);
      const createRequestId = input.createRequestId ?? ((runId) => `${runId}:cancellation`);
      const now = input.now ?? (() => new Date().toISOString());
      const requestId = createRequestId(input.runId);
      const requestedAt = now();
      assertNonEmpty(requestId, "cancellation request id");
      assertDateTime(requestedAt, "cancellation requestedAt");

      request = Object.freeze({
        id: requestId,
        runId: input.runId,
        origin: requestInput.origin,
        reasonCode: requestInput.reasonCode,
        reason: normalizeReason(requestInput.reason),
        approvalRequestId: normalizeOptionalText(requestInput.approvalRequestId),
        parentRunId: normalizeOptionalText(requestInput.parentRunId),
        requestedAt,
      });

      abortController.abort(request);
      return Object.freeze({ accepted: true, request });
    },
  });
}

export function toRunCancellationSummary(
  request: RunCancellationRequest,
): RunCancellationSummary {
  return Object.freeze({
    requestId: request.id,
    origin: request.origin,
    reasonCode: request.reasonCode,
    requestedAt: request.requestedAt,
  });
}

function validateRequestInput(input: RunCancellationRequestInput): void {
  const allowedReasonCodes = originReasonCodes[input.origin];
  if (allowedReasonCodes === undefined || !allowedReasonCodes.includes(input.reasonCode)) {
    throw new TypeError(
      `Cancellation reasonCode ${input.reasonCode} is not valid for origin ${input.origin}.`,
    );
  }

  if (input.origin === "approval") {
    assertNonEmpty(input.approvalRequestId, "approvalRequestId");
  } else if (input.approvalRequestId !== undefined) {
    throw new TypeError("approvalRequestId is valid only for approval cancellation.");
  }

  if (input.origin === "parent_run") {
    assertNonEmpty(input.parentRunId, "parentRunId");
  } else if (input.parentRunId !== undefined) {
    throw new TypeError("parentRunId is valid only for parent_run cancellation.");
  }
}

function normalizeOptionalText(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function normalizeReason(value: string | undefined): string | null {
  const normalized = normalizeOptionalText(value);
  if (normalized === null) {
    return null;
  }
  if (normalized.length > MAX_CANCELLATION_REASON_LENGTH) {
    throw new TypeError(
      `cancellation reason must not exceed ${MAX_CANCELLATION_REASON_LENGTH} characters.`,
    );
  }
  return normalized;
}

function assertDateTime(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid date-time string.`);
  }
}

function assertNonEmpty(value: string | undefined, field: string): asserts value is string {
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}
