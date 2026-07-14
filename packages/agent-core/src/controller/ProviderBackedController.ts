import type {
  Provider,
  ProviderCallResult,
  ProviderFailure,
  ProviderRequest,
  ProviderResponse,
} from "@agent-anything/providers";
import type {
  ISODateTimeString,
  InvocationInterruptionContext,
  InvocationInterruptionRef,
  Metadata,
} from "@agent-anything/shared";
import {
  RetryExecutor,
  type RetryAttemptContext,
  type RetryClassification,
  type RetryClock,
  type RetryExhaustedEvent,
  type RetryFailure,
  type RetryOperation,
} from "../retry/index.js";
import type { ActionCandidate, ActionKind } from "../runner/Action.js";
import type { RuntimeError } from "../runner/RuntimeError.js";
import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
  ControllerModelItem,
} from "./Controller.js";

export type BuildProviderRequest<TOutput = unknown> = (
  input: ControllerInput<TOutput>,
) => ProviderRequest | Promise<ProviderRequest>;

export type ParseProviderResponse<TOutput = unknown> = (
  response: ProviderResponse,
  input: ControllerInput<TOutput>,
) => ControllerDecision<TOutput> | Promise<ControllerDecision<TOutput>>;

export type ControllerFailureCode =
  | "model_request_failed"
  | "model_output_invalid"
  | "provider_request_failed"
  | "provider_timeout"
  | "provider_retry_exhausted"
  | "provider_cancellation_unconfirmed";

export interface ControllerFailure extends RuntimeError {
  readonly owner: "model" | "provider";
  readonly code: ControllerFailureCode;
}

export class ControllerError extends Error {
  constructor(
    readonly runtimeError: ControllerFailure,
    readonly boundarySettlement: "unsettled" | "settled_failure" = "unsettled",
  ) {
    super(runtimeError.message);
    this.name = "ControllerError";
  }
}

export interface ProviderBackedControllerInput<TOutput = unknown> {
  readonly provider: Provider;
  readonly buildRequest: BuildProviderRequest<TOutput>;
  readonly parseResponse: ParseProviderResponse<TOutput>;
  readonly maxProviderOutputLength: number;
  readonly retryExecutor: RetryExecutor;
  readonly retryClock: RetryClock;
}

type ProviderRetryCategory =
  | "transport"
  | "timeout"
  | "rate_limit"
  | "server_error"
  | "deadline"
  | "authentication"
  | "invalid_request"
  | "response"
  | "cancellation"
  | "provider";

interface ProviderAttemptFailure {
  readonly failure: ProviderFailure;
  readonly deadlineReason: RetryAttemptContext["deadlineReason"];
}

export class ProviderBackedController<TOutput = unknown>
  implements Controller<TOutput>
{
  constructor(private readonly input: ProviderBackedControllerInput<TOutput>) {
    if (
      !Number.isInteger(input.maxProviderOutputLength) ||
      input.maxProviderOutputLength <= 0
    ) {
      throw new TypeError("maxProviderOutputLength must be a positive integer.");
    }
    if (typeof input.retryExecutor?.execute !== "function") {
      throw new TypeError("ProviderBackedController requires a RetryExecutor.");
    }
    if (typeof input.retryClock?.now !== "function") {
      throw new TypeError("ProviderBackedController requires a RetryClock.");
    }
    if (input.provider.descriptor.requestRetryScheduler?.kind !== "platform") {
      throw new TypeError(
        "ProviderBackedController requires platform-owned Provider request Retry.",
      );
    }
  }

  async next(
    controllerInput: ControllerInput<TOutput>,
    callContext: ControllerCallContext,
  ): Promise<ControllerDecision<TOutput>> {
    throwIfCancelled(callContext);
    const request = await this.buildRequest(controllerInput);

    throwIfCancelled(callContext);
    const response = await this.sendRequest(request, controllerInput, callContext, 1);

    throwIfCancelled(callContext);
    this.assertOutputLength(response);
    const decision = await this.parseResponse(response, controllerInput);

    throwIfCancelled(callContext);
    return validateDecision(decision, controllerInput);
  }

  private async buildRequest(
    input: ControllerInput<TOutput>,
  ): Promise<ProviderRequest> {
    try {
      return snapshotProviderRequest(await this.input.buildRequest(input));
    } catch (error) {
      throw createControllerError(
        "model",
        "model_request_failed",
        messageFrom(error, "Model request construction failed."),
        false,
        errorMetadata(error),
      );
    }
  }

  private async sendRequest(
    request: ProviderRequest,
    controllerInput: ControllerInput<TOutput>,
    callContext: ControllerCallContext,
    providerRequestNumber: number,
  ): Promise<ProviderResponse> {
    const operation = createProviderRetryOperation(
      controllerInput,
      callContext.retry.deadlineAt,
      providerRequestNumber,
      this.input.retryClock,
    );
    const budgetId = `${operation.operationId}:budget:1`;
    let result;
    try {
      result = await this.input.retryExecutor.execute(
        {
          operation,
          budgetId,
          priorProgress: { completedAttempts: 0, totalRetryDelayMs: 0 },
          policy: callContext.retry.providerRequest,
          classifier: { classify: classifyProviderAttemptFailure },
          cancellation: callContext.cancellation,
          events: callContext.retry.events,
        },
        async (attempt) => {
          const providerResult = await this.input.provider.send(
            recreateProviderRequest(request),
            createInvocationInterruptionContext(callContext, attempt),
          );
          return providerAttemptResult(
            providerResult,
            callContext,
            attempt,
            this.input.retryClock,
          );
        },
      );
    } catch (error) {
      if (callContext.cancellation.signal.aborted) {
        throw providerCancellationUnconfirmedError(
          "Provider request did not confirm the active Run cancellation.",
          this.input.provider.descriptor.id,
          errorMetadata(error),
        );
      }
      throw createControllerError(
        "provider",
        "provider_request_failed",
        "Provider request failed.",
        false,
        {
          providerId: this.input.provider.descriptor.id,
          ...errorMetadata(error),
        },
      );
    }

    switch (result.kind) {
      case "succeeded":
        return result.value;

      case "failed":
        throw providerRetryFailureError(
          result.failure,
          this.input.provider.descriptor.id,
        );

      case "cancelled":
        throw callContext.cancellation.signal.reason;

      case "budget_exhausted":
        await callContext.retry.events.emit(retryBudgetExhaustedEvent(
          operation,
          result.exhaustion.budgetId,
          result.exhaustion.progress.completedAttempts,
          result.exhaustion.progress.totalRetryDelayMs,
          result.exhaustion.lastFailure,
          result.exhaustion.exhaustedAt,
        ));
        throw providerRetryExhaustedError(
          "retry_budget_exhausted",
          result.exhaustion.operationId,
          result.exhaustion.progress.completedAttempts,
          result.exhaustion.progress.totalRetryDelayMs,
          result.exhaustion.lastFailure,
          this.input.provider.descriptor.id,
        );

      case "deadline_exhausted":
        throw providerRetryExhaustedError(
          "deadline_exceeded",
          result.exhaustion.operationId,
          result.exhaustion.totalAttempts,
          result.exhaustion.totalRetryDelayMs,
          result.exhaustion.lastFailure,
          this.input.provider.descriptor.id,
        );
    }
  }

  private assertOutputLength(response: ProviderResponse): void {
    if (response.output === null || response.output === undefined) {
      throw invalidOutput("Provider returned no output.");
    }

    let serialized: string | undefined;
    try {
      serialized =
        typeof response.output === "string"
          ? response.output
          : JSON.stringify(response.output);
    } catch (error) {
      throw invalidOutput(
        "Provider output could not be measured.",
        errorMetadata(error),
      );
    }

    if (serialized === undefined) {
      throw invalidOutput("Provider output could not be measured.");
    }

    if (serialized.length > this.input.maxProviderOutputLength) {
      throw invalidOutput("Provider output exceeds the configured limit.", {
        maxProviderOutputLength: this.input.maxProviderOutputLength,
        actualProviderOutputLength: serialized.length,
      });
    }
  }

  private async parseResponse(
    response: ProviderResponse,
    input: ControllerInput<TOutput>,
  ): Promise<ControllerDecision<TOutput>> {
    try {
      return await this.input.parseResponse(response, input);
    } catch (error) {
      if (error instanceof ControllerError) {
        throw error;
      }

      throw invalidOutput(
        messageFrom(error, "Provider output parsing failed."),
        errorMetadata(error),
      );
    }
  }
}

function validateDecision<TOutput>(
  candidate: ControllerDecision<TOutput>,
  input: ControllerInput<TOutput>,
): ControllerDecision<TOutput> {
  if (!isRecord(candidate)) {
    throw invalidOutput("Controller decision must be an object.");
  }

  const modelItems = validateModelItems(candidate.modelItems);
  const modelItemIds = new Set(modelItems.map((item) => item.id));

  switch (candidate.kind) {
    case "final_output": {
      let validation;
      try {
        validation = input.agent.output.validate(candidate.output);
      } catch (error) {
        throw invalidOutput(
          "Agent output validation failed.",
          errorMetadata(error),
        );
      }

      if (!validation.valid) {
        throw invalidOutput(validation.message);
      }

      return Object.freeze({
        kind: "final_output",
        output: validation.output,
        modelItems,
      });
    }

    case "actions":
      return Object.freeze({
        kind: "actions",
        actions: validateActions(candidate.actions, modelItemIds),
        modelItems,
      });

    case "stop":
      return Object.freeze({
        kind: "stop",
        reason: nonEmptyText(candidate.reason, "Stop reason"),
        modelItems,
      });

    default:
      throw invalidOutput("Controller decision kind is not supported.");
  }
}

function validateModelItems(candidate: unknown): readonly ControllerModelItem[] {
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw invalidOutput("Controller decision must include model items.");
  }

  const ids = new Set<string>();
  const items = candidate.map((item, index) => {
    if (!isRecord(item)) {
      throw invalidOutput(`Model item at index ${index} must be an object.`);
    }

    const id = nonEmptyText(item.id, `Model item ${index} id`);
    if (ids.has(id)) {
      throw invalidOutput(`Model item id ${id} is duplicated.`);
    }
    ids.add(id);

    if (!isRecord(item.metadata)) {
      throw invalidOutput(`Model item ${id} metadata must be an object.`);
    }

    return Object.freeze({
      id,
      kind: nonEmptyText(item.kind, `Model item ${id} kind`),
      content: item.content,
      metadata: Object.freeze({ ...item.metadata }),
    });
  });

  return Object.freeze(items);
}

function validateActions(
  candidate: unknown,
  modelItemIds: ReadonlySet<string>,
): readonly [ActionCandidate, ...ActionCandidate[]] {
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw invalidOutput("Actions decision must include at least one action.");
  }

  const actions = candidate.map((action, index) => {
    if (!isRecord(action)) {
      throw invalidOutput(`Action at index ${index} must be an object.`);
    }

    const kind = validateActionKind(action.kind, index);
    const modelItemId = nonEmptyText(action.modelItemId, `Action ${index} modelItemId`);
    if (!modelItemIds.has(modelItemId)) {
      throw invalidOutput(
        `Action ${index} references unknown model item ${modelItemId}.`,
      );
    }

    return Object.freeze({
      kind,
      name: nonEmptyText(action.name, `Action ${index} name`),
      input: action.input,
      modelItemId,
    });
  });

  return Object.freeze(actions) as unknown as readonly [
    ActionCandidate,
    ...ActionCandidate[],
  ];
}

function validateActionKind(candidate: unknown, index: number): ActionKind {
  if (
    candidate !== "internal" &&
    candidate !== "tool" &&
    candidate !== "permission_request"
  ) {
    throw invalidOutput(`Action ${index} kind is not supported.`);
  }

  return candidate;
}

function nonEmptyText(candidate: unknown, field: string): string {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw invalidOutput(`${field} must be a non-empty string.`);
  }

  return candidate.trim();
}

function throwIfCancelled(context: ControllerCallContext): void {
  if (context.cancellation.signal.aborted) {
    throw context.cancellation.signal.reason;
  }
}

function invalidOutput(
  message: string,
  metadata: Metadata = {},
): ControllerError {
  return createControllerError(
    "model",
    "model_output_invalid",
    message,
    false,
    metadata,
  );
}

function createControllerError(
  owner: ControllerFailure["owner"],
  code: ControllerFailureCode,
  message: string,
  retryable: boolean,
  metadata: Metadata,
  boundarySettlement: "unsettled" | "settled_failure" = "unsettled",
): ControllerError {
  return new ControllerError(
    Object.freeze({
      owner,
      code,
      message,
      retryable,
      metadata: Object.freeze({ ...metadata }),
    }),
    boundarySettlement,
  );
}

function createInvocationInterruptionContext(
  context: ControllerCallContext,
  attempt: RetryAttemptContext,
): InvocationInterruptionContext {
  return Object.freeze({
    signal: attempt.signal,
    get interruption(): InvocationInterruptionRef | null {
      const deadline = attempt.deadlineReason;
      if (deadline !== null) {
        return Object.freeze({
          kind: "operation_deadline" as const,
          deadline: Object.freeze({
            operationId: deadline.operationId,
            deadlineAt: deadline.deadlineAt,
          }),
        });
      }
      const request = context.cancellation.request;
      return request === null || !context.cancellation.signal.aborted
        ? null
        : Object.freeze({
            kind: "run_cancellation" as const,
            cancellation: Object.freeze({
              runId: request.runId,
              requestId: request.id,
            }),
          });
    },
  });
}

function providerAttemptResult(
  result: ProviderCallResult,
  context: ControllerCallContext,
  attempt: RetryAttemptContext,
  clock: RetryClock,
) {
  if (attempt.signal.aborted) {
    if (attempt.deadlineReason !== null) {
      return {
        kind: "failed" as const,
        error: {
          failure: providerOperationDeadlineFailure(attempt.deadlineReason),
          deadlineReason: attempt.deadlineReason,
        },
      };
    }
    if (context.cancellation.signal.aborted && context.cancellation.request !== null) {
      return {
        kind: "cancelled" as const,
        attribution: providerCancellationAttribution(context, clock),
      };
    }
  }

  switch (result.kind) {
    case "succeeded":
      return { kind: "succeeded" as const, value: result.response };
    case "failed":
      return {
        kind: "failed" as const,
        error: { failure: result.failure, deadlineReason: attempt.deadlineReason },
      };
    case "cancelled":
      if (matchesActiveCancellation(result.cancellation, context)) {
        return {
          kind: "cancelled" as const,
          attribution: providerCancellationAttribution(context, clock),
        };
      }
      return {
        kind: "failed" as const,
        error: {
          failure: providerCancellationFailure(
            "Provider returned cancellation without the active Run correlation.",
            result.cancellation.requestId,
          ),
          deadlineReason: null,
        },
      };
    case "cancellation_unconfirmed":
      return {
        kind: "failed" as const,
        error: { failure: result.failure, deadlineReason: null },
      };
  }
}

function classifyProviderAttemptFailure(
  error: ProviderAttemptFailure,
): RetryClassification<ProviderRetryCategory> {
  const failure = error.failure;
  if (
    error.deadlineReason !== null &&
    failure.code === "provider_operation_deadline"
  ) {
    return classification(failure, "deadline", "deadline_exceeded");
  }
  if (
    failure.code === "provider_cancellation_unconfirmed" ||
    failure.category === "cancellation"
  ) {
    return classification(failure, "cancellation", "non_retryable");
  }
  if (
    failure.category === "timeout" ||
    failure.code === "provider_timeout" ||
    failure.statusCode === 408
  ) {
    return classification(failure, "timeout", "retryable");
  }
  if (failure.category === "rate_limit" || failure.statusCode === 429) {
    return classification(failure, "rate_limit", "retryable");
  }
  if (
    failure.category === "server_error" ||
    failure.statusCode !== undefined &&
    failure.statusCode >= 500 &&
    failure.statusCode <= 599
  ) {
    return classification(failure, "server_error", "retryable");
  }
  if (failure.category === "transport") {
    return classification(failure, "transport", "retryable");
  }
  if (
    failure.category === "authentication" ||
    failure.statusCode === 401 ||
    failure.statusCode === 403
  ) {
    return classification(failure, "authentication", "non_retryable");
  }
  if (
    failure.category === "response" ||
    failure.code === "provider_response_malformed" ||
    failure.code === "provider_response_too_large"
  ) {
    return classification(failure, "response", "non_retryable");
  }
  if (
    failure.category === "invalid_request" ||
    failure.statusCode !== undefined && failure.statusCode >= 400
  ) {
    return classification(failure, "invalid_request", "non_retryable");
  }
  return classification(failure, "provider", "non_retryable");
}

function classification(
  failure: ProviderFailure,
  category: ProviderRetryCategory,
  disposition: RetryClassification<ProviderRetryCategory>["disposition"],
): RetryClassification<ProviderRetryCategory> {
  return {
    failure: {
      category,
      code: failure.code,
      message: failure.message,
      ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
      ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
      ...(failure.statusCode === undefined ? {} : { statusCode: failure.statusCode }),
    },
    disposition,
    reasonCode: failure.code,
  };
}

function createProviderRetryOperation<TOutput>(
  input: ControllerInput<TOutput>,
  deadlineAt: ISODateTimeString,
  providerRequestNumber: number,
  clock: RetryClock,
): RetryOperation {
  const controllerRequestId = `${input.runId}:controller:${input.iteration}`;
  return Object.freeze({
    operationId: `${controllerRequestId}:provider-request:${providerRequestNumber}`,
    owner: "provider_request",
    runId: input.runId,
    subject: Object.freeze({ kind: "provider_request", controllerRequestId }),
    startedAt: retryNow(clock),
    deadlineAt,
  });
}

function providerCancellationAttribution(
  context: ControllerCallContext,
  clock: RetryClock,
) {
  const request = context.cancellation.request;
  if (!context.cancellation.signal.aborted || request === null) {
    throw new TypeError("Provider cancellation requires the active Run request.");
  }
  return Object.freeze({
    requestId: request.id,
    runId: request.runId,
    boundary: "provider" as const,
    observedAt: retryNow(clock),
  });
}

function providerOperationDeadlineFailure(
  deadline: NonNullable<RetryAttemptContext["deadlineReason"]>,
): ProviderFailure {
  return Object.freeze({
    category: "deadline",
    code: "provider_operation_deadline",
    message: "Provider operation deadline was exceeded.",
    metadata: Object.freeze({
      operationId: deadline.operationId,
      deadlineAt: deadline.deadlineAt,
    }),
  });
}

function providerCancellationFailure(message: string, requestId?: string): ProviderFailure {
  return Object.freeze({
    category: "cancellation",
    code: "provider_cancellation_unconfirmed",
    message,
    ...(requestId === undefined ? {} : { requestId }),
    metadata: Object.freeze({}),
  });
}

function retryBudgetExhaustedEvent(
  operation: RetryOperation,
  budgetId: string,
  totalAttempts: number,
  totalRetryDelayMs: number,
  lastFailure: RetryFailure,
  occurredAt: ISODateTimeString,
): RetryExhaustedEvent {
  return Object.freeze({
    type: "retry_exhausted",
    runId: operation.runId,
    operationId: operation.operationId,
    owner: operation.owner,
    occurredAt,
    finalBudgetId: budgetId,
    reason: "retry_budget_exhausted",
    totalAttempts,
    totalRetryDelayMs,
    lastFailureCategory: lastFailure.category,
    lastFailureCode: lastFailure.code,
  });
}

function retryNow(clock: RetryClock): ISODateTimeString {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("RetryClock.now() must return a valid Date.");
  }
  return value.toISOString();
}

function matchesActiveCancellation(
  candidate: { readonly runId: string; readonly requestId: string },
  context: ControllerCallContext,
): boolean {
  const request = context.cancellation.request;
  return context.cancellation.signal.aborted &&
    request !== null &&
    candidate.runId === request.runId &&
    candidate.requestId === request.id;
}

function providerRetryFailureError(
  failure: RetryFailure,
  providerId: string,
): ControllerError {
  const code: Extract<
    ControllerFailureCode,
    "provider_request_failed" | "provider_timeout" | "provider_cancellation_unconfirmed"
  > = failure.code === "provider_cancellation_unconfirmed"
    ? "provider_cancellation_unconfirmed"
    : failure.category === "timeout" || failure.code === "provider_timeout"
      ? "provider_timeout"
      : "provider_request_failed";
  return createControllerError(
    "provider",
    code,
    failure.message,
    false,
    {
      providerId,
      providerFailureCategory: failure.category,
      providerErrorCode: failure.code,
      providerRequestId: failure.requestId ?? null,
      providerStatusCode: failure.statusCode ?? null,
      providerRetryAfterMs: failure.retryAfterMs ?? null,
    },
    "settled_failure",
  );
}

function providerRetryExhaustedError(
  reason: "retry_budget_exhausted" | "deadline_exceeded",
  operationId: string,
  totalAttempts: number,
  totalRetryDelayMs: number,
  lastFailure: RetryFailure | null,
  providerId: string,
): ControllerError {
  return createControllerError(
    "provider",
    "provider_retry_exhausted",
    "Provider request Retry was exhausted.",
    false,
    {
      providerId,
      retryOperationId: operationId,
      retryExhaustionReason: reason,
      retryTotalAttempts: totalAttempts,
      retryTotalDelayMs: totalRetryDelayMs,
      providerFailureCategory: lastFailure?.category ?? null,
      providerErrorCode: lastFailure?.code ?? null,
      providerRequestId: lastFailure?.requestId ?? null,
      providerStatusCode: lastFailure?.statusCode ?? null,
    },
    "settled_failure",
  );
}

function providerCancellationUnconfirmedError(
  message: string,
  providerId: string,
  metadata: Metadata,
): ControllerError {
  return createControllerError(
    "provider",
    "provider_cancellation_unconfirmed",
    message,
    false,
    { providerId, ...metadata },
    "settled_failure",
  );
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : fallback;
}

function errorMetadata(error: unknown): Metadata {
  if (!(error instanceof Error)) {
    return {};
  }

  const code = "code" in error && typeof error.code === "string" ? error.code : null;
  return {
    causeName: error.name,
    causeCode: code,
  };
}

function snapshotProviderRequest(request: ProviderRequest): ProviderRequest {
  if (!isRecord(request) || !Array.isArray(request.messages)) {
    throw new TypeError("Provider request must include a messages array.");
  }
  if (typeof request.capability !== "string" || request.capability.trim().length === 0) {
    throw new TypeError("Provider request capability must be a non-empty string.");
  }
  if (!isRecord(request.metadata)) {
    throw new TypeError("Provider request metadata must be an object.");
  }
  const messages = request.messages.map((message, index) => {
    if (!isRecord(message)) {
      throw new TypeError(`Provider message ${index} must be an object.`);
    }
    if (!["system", "user", "assistant", "tool"].includes(message.role as string)) {
      throw new TypeError(`Provider message ${index} role is unsupported.`);
    }
    if (typeof message.content !== "string") {
      throw new TypeError(`Provider message ${index} content must be a string.`);
    }
    if (!isRecord(message.metadata)) {
      throw new TypeError(`Provider message ${index} metadata must be an object.`);
    }
    return Object.freeze({
      role: message.role as "system" | "user" | "assistant" | "tool",
      content: message.content,
      metadata: Object.freeze({ ...message.metadata }),
    });
  });
  return Object.freeze({
    messages: Object.freeze(messages) as unknown as ProviderRequest["messages"],
    capability: request.capability,
    metadata: Object.freeze({ ...request.metadata }),
  });
}

function recreateProviderRequest(request: ProviderRequest): ProviderRequest {
  return {
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      metadata: { ...message.metadata },
    })),
    capability: request.capability,
    metadata: { ...request.metadata },
  };
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}
