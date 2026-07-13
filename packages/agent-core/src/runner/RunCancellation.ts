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
      assertNonEmpty(requestedAt, "cancellation requestedAt");

      request = Object.freeze({
        id: requestId,
        runId: input.runId,
        origin: requestInput.origin,
        reasonCode: requestInput.reasonCode,
        reason: normalizeOptionalText(requestInput.reason),
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

function assertNonEmpty(value: string | undefined, field: string): asserts value is string {
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}
