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
import {
  StructuredOutputError,
  snapshotStructuredOutputFailure,
  type ProviderRequestBuildContext,
  type StructuredOutputFailure,
  type StructuredOutputFailureCategory,
} from "./StructuredOutput.js";

export type BuildProviderRequest<TOutput = unknown> = (
  input: ControllerInput<TOutput>,
  context: ProviderRequestBuildContext,
) => ProviderRequest | Promise<ProviderRequest>;

export type ParseProviderResponse<TOutput = unknown> = (
  response: ProviderResponse,
  input: ControllerInput<TOutput>,
) => ControllerDecision<TOutput> | Promise<ControllerDecision<TOutput>>;

export type ControllerFailureCode =
  | "model_request_failed"
  | "model_output_invalid"
  | "model_structured_output_retry_exhausted"
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
  readonly structuredOutputContractId: string;
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

type StructuredOutputRetryCategory =
  | StructuredOutputFailureCategory
  | "deadline"
  | "owner_failure";

type StructuredOutputAttemptFailure =
  | {
      readonly kind: "correction";
      readonly failure: StructuredOutputFailure;
    }
  | {
      readonly kind: "deadline";
      readonly operationId: string;
      readonly deadlineAt: ISODateTimeString;
    }
  | {
      readonly kind: "terminal";
      readonly error: unknown;
    };

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
    if (
      typeof input.structuredOutputContractId !== "string" ||
      input.structuredOutputContractId.trim().length === 0
    ) {
      throw new TypeError(
        "ProviderBackedController requires a structuredOutputContractId.",
      );
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
    const decision = await this.executeStructuredOutput(
      controllerInput,
      callContext,
    );
    throwIfCancelled(callContext);
    return decision;
  }

  private async executeStructuredOutput(
    controllerInput: ControllerInput<TOutput>,
    callContext: ControllerCallContext,
  ): Promise<ControllerDecision<TOutput>> {
    const operation = createStructuredOutputRetryOperation(
      controllerInput,
      this.input.structuredOutputContractId,
      callContext.retry.deadlineAt,
      this.input.retryClock,
    );
    const budgetId = `${operation.operationId}:budget:1`;
    let correction: ProviderRequestBuildContext["correction"] = null;
    let providerRequestNumber = 0;
    let result;

    try {
      result = await this.input.retryExecutor.execute(
        {
          operation,
          budgetId,
          priorProgress: { completedAttempts: 0, totalRetryDelayMs: 0 },
          policy: callContext.retry.structuredOutput,
          classifier: { classify: classifyStructuredOutputAttemptFailure },
          cancellation: callContext.cancellation,
          events: callContext.retry.events,
        },
        async (attempt) => {
          const interruptedBeforeBuild = structuredOutputInterruption(
            attempt,
            callContext,
            this.input.retryClock,
          );
          if (interruptedBeforeBuild !== null) {
            return interruptedBeforeBuild;
          }

          const buildContext = Object.freeze({
            attemptNumber: attempt.attempt.attemptNumber,
            correction,
          });
          let request: ProviderRequest;
          try {
            request = await this.buildRequest(controllerInput, buildContext);
          } catch (error) {
            return terminalStructuredOutputFailure(error);
          }

          const interruptedBeforeProvider = structuredOutputInterruption(
            attempt,
            callContext,
            this.input.retryClock,
          );
          if (interruptedBeforeProvider !== null) {
            return interruptedBeforeProvider;
          }

          providerRequestNumber += 1;
          let response: ProviderResponse;
          try {
            response = await this.sendRequest(
              request,
              controllerInput,
              callContext,
              providerRequestNumber,
            );
          } catch (error) {
            if (matchesActiveCancellationError(error, callContext)) {
              return {
                kind: "cancelled" as const,
                attribution: controllerCancellationAttribution(
                  callContext,
                  this.input.retryClock,
                ),
              };
            }
            return terminalStructuredOutputFailure(error);
          }

          const interruptedBeforeParsing = structuredOutputInterruption(
            attempt,
            callContext,
            this.input.retryClock,
          );
          if (interruptedBeforeParsing !== null) {
            return interruptedBeforeParsing;
          }

          try {
            this.assertOutputLength(response);
            const parsed = await this.parseResponse(response, controllerInput);
            const decision = validateDecision(parsed, controllerInput);
            const interruptedAfterValidation = structuredOutputInterruption(
              attempt,
              callContext,
              this.input.retryClock,
            );
            return interruptedAfterValidation ?? {
              kind: "succeeded" as const,
              value: decision,
            };
          } catch (error) {
            if (error instanceof StructuredOutputError) {
              const interruptedDuringValidation = structuredOutputInterruption(
                attempt,
                callContext,
                this.input.retryClock,
              );
              if (interruptedDuringValidation !== null) {
                return interruptedDuringValidation;
              }
              const failure = snapshotStructuredOutputFailure(error.failure);
              correction = Object.freeze({
                previousAttemptNumber: attempt.attempt.attemptNumber,
                failure,
              });
              return {
                kind: "failed" as const,
                error: Object.freeze({
                  kind: "correction" as const,
                  failure,
                }),
              };
            }
            return terminalStructuredOutputFailure(error);
          }
        },
      );
    } catch (error) {
      throw createControllerError(
        "model",
        "model_output_invalid",
        "Structured-output Retry failed internally.",
        false,
        errorMetadata(error),
      );
    }

    switch (result.kind) {
      case "succeeded":
        return result.value;
      case "cancelled":
        throw callContext.cancellation.signal.reason;
      case "failed":
        if (result.error.kind === "terminal") {
          throw result.error.error;
        }
        if (result.error.kind === "deadline") {
          throw new TypeError("Structured-output deadline returned as non-terminal failure.");
        }
        throw structuredOutputFailureError(
          result.failure,
          operation.operationId,
        );
      case "budget_exhausted":
        await callContext.retry.events.emit(retryBudgetExhaustedEvent(
          operation,
          result.exhaustion.budgetId,
          result.exhaustion.progress.completedAttempts,
          result.exhaustion.progress.totalRetryDelayMs,
          result.exhaustion.lastFailure,
          result.exhaustion.exhaustedAt,
        ));
        throw structuredOutputRetryExhaustedError(
          "retry_budget_exhausted",
          result.exhaustion.operationId,
          result.exhaustion.progress.completedAttempts,
          result.exhaustion.progress.totalRetryDelayMs,
          result.exhaustion.lastFailure,
        );
      case "deadline_exhausted":
        throw structuredOutputRetryExhaustedError(
          "deadline_exceeded",
          result.exhaustion.operationId,
          result.exhaustion.totalAttempts,
          result.exhaustion.totalRetryDelayMs,
          result.exhaustion.lastFailure,
        );
    }
  }

  private async buildRequest(
    input: ControllerInput<TOutput>,
    context: ProviderRequestBuildContext,
  ): Promise<ProviderRequest> {
    try {
      return snapshotProviderRequest(await this.input.buildRequest(input, context));
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
      throw structuredOutputError(
        "structured_output_schema",
        "structured_output_missing",
        "Return one structured output value that satisfies the active contract.",
      );
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
      throw structuredOutputError(
        "structured_output_schema",
        "structured_output_missing",
        "Return one structured output value that satisfies the active contract.",
      );
    }

    if (serialized.length > this.input.maxProviderOutputLength) {
      throw structuredOutputError(
        "structured_output_size",
        "structured_output_too_large",
        "Return a shorter structured output within the configured output limit.",
      );
    }
  }

  private async parseResponse(
    response: ProviderResponse,
    input: ControllerInput<TOutput>,
  ): Promise<ControllerDecision<TOutput>> {
    try {
      return await this.input.parseResponse(response, input);
    } catch (error) {
      if (error instanceof ControllerError || error instanceof StructuredOutputError) {
        throw error;
      }

      throw invalidOutput(
        "Provider output parsing failed.",
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
    throw decisionContractError("controller_decision_invalid");
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
        throw structuredOutputError(
          "agent_output_contract",
          "agent_output_invalid",
          "Return a final output that satisfies the active Agent output contract.",
        );
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
        reason: nonEmptyDecisionText(candidate.reason),
        modelItems,
      });

    default:
      throw decisionContractError("controller_decision_kind_invalid");
  }
}

function validateModelItems(candidate: unknown): readonly ControllerModelItem[] {
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw decisionContractError("controller_model_items_required");
  }

  const ids = new Set<string>();
  const items = candidate.map((item) => {
    if (!isRecord(item)) {
      throw decisionContractError("controller_model_item_invalid");
    }

    const id = nonEmptyDecisionText(item.id);
    if (ids.has(id)) {
      throw decisionContractError("controller_model_item_id_duplicated");
    }
    ids.add(id);

    if (!isRecord(item.metadata)) {
      throw decisionContractError("controller_model_item_metadata_invalid");
    }

    return Object.freeze({
      id,
      kind: nonEmptyDecisionText(item.kind),
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
    throw decisionContractError("controller_actions_required");
  }

  const actions = candidate.map((action) => {
    if (!isRecord(action)) {
      throw decisionContractError("controller_action_invalid");
    }

    const kind = validateActionKind(action.kind);
    const modelItemId = nonEmptyDecisionText(action.modelItemId);
    if (!modelItemIds.has(modelItemId)) {
      throw decisionContractError("controller_action_provenance_invalid");
    }

    return Object.freeze({
      kind,
      name: nonEmptyDecisionText(action.name),
      input: action.input,
      modelItemId,
    });
  });

  return Object.freeze(actions) as unknown as readonly [
    ActionCandidate,
    ...ActionCandidate[],
  ];
}

function validateActionKind(candidate: unknown): ActionKind {
  if (
    candidate !== "internal" &&
    candidate !== "tool" &&
    candidate !== "permission_request"
  ) {
    throw decisionContractError("controller_action_kind_invalid");
  }

  return candidate;
}

function nonEmptyDecisionText(candidate: unknown): string {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw decisionContractError("controller_text_field_invalid");
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

function structuredOutputError(
  category: StructuredOutputFailureCategory,
  code: string,
  correctionFeedback: string,
): StructuredOutputError {
  return new StructuredOutputError({ category, code, correctionFeedback });
}

function decisionContractError(code: string): StructuredOutputError {
  return structuredOutputError(
    "structured_output_schema",
    code,
    "Return exactly one decision that satisfies the active Controller output contract.",
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

function structuredOutputInterruption(
  attempt: RetryAttemptContext,
  context: ControllerCallContext,
  clock: RetryClock,
) {
  if (!attempt.signal.aborted) {
    return null;
  }
  if (attempt.deadlineReason !== null) {
    return {
      kind: "failed" as const,
      error: Object.freeze({
        kind: "deadline" as const,
        operationId: attempt.deadlineReason.operationId,
        deadlineAt: attempt.deadlineReason.deadlineAt,
      }),
    };
  }
  if (context.cancellation.signal.aborted && context.cancellation.request !== null) {
    return {
      kind: "cancelled" as const,
      attribution: controllerCancellationAttribution(context, clock),
    };
  }
  return terminalStructuredOutputFailure(invalidOutput(
    "Structured-output attempt was interrupted without trusted attribution.",
  ));
}

function terminalStructuredOutputFailure(error: unknown) {
  return {
    kind: "failed" as const,
    error: Object.freeze({ kind: "terminal" as const, error }),
  };
}

function classifyStructuredOutputAttemptFailure(
  error: StructuredOutputAttemptFailure,
): RetryClassification<StructuredOutputRetryCategory> {
  if (error.kind === "deadline") {
    return {
      failure: {
        category: "deadline",
        code: "structured_output_deadline_exceeded",
        message: "Structured-output operation deadline was exceeded.",
      },
      disposition: "deadline_exceeded",
      reasonCode: "structured_output_deadline_exceeded",
    };
  }
  if (error.kind === "terminal") {
    const code = error.error instanceof ControllerError
      ? error.error.runtimeError.code
      : "structured_output_owner_failure";
    return {
      failure: {
        category: "owner_failure",
        code,
        message: "Structured-output attempt returned to its owner.",
      },
      disposition: "non_retryable",
      reasonCode: code,
    };
  }
  return {
    failure: {
      category: error.failure.category,
      code: error.failure.code,
      message: error.failure.correctionFeedback,
    },
    disposition: "retryable",
    reasonCode: error.failure.code,
  };
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

function createStructuredOutputRetryOperation<TOutput>(
  input: ControllerInput<TOutput>,
  contractId: string,
  deadlineAt: ISODateTimeString,
  clock: RetryClock,
): RetryOperation {
  const controllerRequestId = `${input.runId}:controller:${input.iteration}`;
  return Object.freeze({
    operationId: `${controllerRequestId}:structured-output:1`,
    owner: "structured_output",
    runId: input.runId,
    subject: Object.freeze({
      kind: "structured_output",
      controllerRequestId,
      contractId,
    }),
    startedAt: retryNow(clock),
    deadlineAt,
  });
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

function controllerCancellationAttribution(
  context: ControllerCallContext,
  clock: RetryClock,
) {
  const request = context.cancellation.request;
  if (!context.cancellation.signal.aborted || request === null) {
    throw new TypeError("Controller cancellation requires the active Run request.");
  }
  return Object.freeze({
    requestId: request.id,
    runId: request.runId,
    boundary: "controller" as const,
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

function matchesActiveCancellationError(
  error: unknown,
  context: ControllerCallContext,
): boolean {
  const request = context.cancellation.request;
  return context.cancellation.signal.aborted &&
    request !== null &&
    (error === request || error === context.cancellation.signal.reason);
}

function structuredOutputFailureError(
  failure: RetryFailure,
  operationId: string,
): ControllerError {
  return createControllerError(
    "model",
    "model_output_invalid",
    "Model output did not satisfy the active structured-output contract.",
    false,
    {
      retryOperationId: operationId,
      structuredOutputFailureCategory: failure.category,
      structuredOutputFailureCode: failure.code,
    },
    "settled_failure",
  );
}

function structuredOutputRetryExhaustedError(
  reason: "retry_budget_exhausted" | "deadline_exceeded",
  operationId: string,
  totalAttempts: number,
  totalRetryDelayMs: number,
  lastFailure: RetryFailure | null,
): ControllerError {
  return createControllerError(
    "model",
    "model_structured_output_retry_exhausted",
    "Structured-output correction Retry was exhausted.",
    false,
    {
      retryOperationId: operationId,
      retryExhaustionReason: reason,
      retryTotalAttempts: totalAttempts,
      retryTotalDelayMs: totalRetryDelayMs,
      structuredOutputFailureCategory: lastFailure?.category ?? null,
      structuredOutputFailureCode: lastFailure?.code ?? null,
    },
    "settled_failure",
  );
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
