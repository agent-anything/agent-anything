import type { InvocationInterruptionContext, InvocationInterruptionRef } from "@agent-anything/agent-core/control";
import type { Provider, ProviderCallResult, ProviderFailure, ProviderRequest, ProviderResponse } from "@agent-anything/model-interaction";
import { createProviderSemanticRequestDigest, snapshotProviderFailure, snapshotProviderRequest } from "@agent-anything/model-interaction";
import { modelInputValueDigest } from "@agent-anything/model-interaction/input";
import { ExecutionFlowPath } from "@agent-anything/observability/execution-flow";
import type { AgentActivityExecutionContext } from "../decision/TaskDecisionActivity.js";
import { ActivityCheckpointError } from "../activity/ActivityCheckpoint.js";
import { TaskDecisionActivityError, type TaskDecisionActivityFailure, type TaskDecisionActivityFailureCode, type DecisionActivityDeadline } from "../decision/TaskDecisionActivityError.js";
import { ModelResponseDelivery } from "./ModelResponseObservation.js";
import { ModelActivityCheckpoint } from "./ModelActivityCheckpoint.js";
import type { RetryAttemptContext, RetryClassification, RetryClock, RetryExhaustedEvent, RetryFailure, RetryOperation } from "../retry/index.js";
import { RetryCheckpointError, type RetryCheckpoint } from "../retry/RetryCheckpoint.js";
import { RetryExecutor } from "../retry/RetryExecutor.js";
import { RetryInvocationInvalidatedError } from "../retry/RetryWaitControl.js";
import { MODEL_ACCESS_EXECUTION_FLOW } from "./ModelAccessExecutionFlow.js";
import { assertModelActivityRequest, type ModelActivityBinding } from "./ModelActivityBinding.js";
import {ModelActivityJournal, type ModelActivityJournalSupport} from "./ModelActivityJournal.js";
import {ModelTransportJournal} from "./ModelTransportJournal.js";
export class ModelRequestAccess {
  private readonly journal: ModelActivityJournal | undefined;
  private readonly transportJournal:ModelTransportJournal|undefined;
  constructor(private readonly input: {
    readonly provider: Provider;
    readonly retryExecutor: RetryExecutor;
    readonly retryClock: RetryClock;
    readonly activityJournal?: ModelActivityJournalSupport;
  }) {
    this.journal = input.activityJournal ? new ModelActivityJournal(input.activityJournal, () => input.retryClock.now().toISOString()) : undefined;
    this.transportJournal=input.activityJournal?.scheduling?new ModelTransportJournal(input.activityJournal,()=>input.retryClock.now().toISOString()):undefined;
  }

  async accept(request: ProviderRequest, activity: ModelActivityBinding, progress: unknown): Promise<void> {
    await this.journal?.accept(request,activity,progress);
  }
  async execute(request: ProviderRequest, context: AgentActivityExecutionContext, requestNumber: number, activity: ModelActivityBinding, delivery?: ModelResponseDelivery): Promise<ProviderRequestSettlement> {
    context.cancellation.signal.throwIfAborted();
    assertModelActivityRequest(activity, request);
    if (context.cancellation.runId !== activity.runId)
      throw new TypeError("Model access cannot cross Run scopes.");
    const records = new ModelActivityCheckpoint(context.checkpoints);
    const key = `activity-binding:${request.requestId}`;
    const retained = await records.once(key, () => activity);
    if (modelInputValueDigest(retained) !== modelInputValueDigest(activity))
      throw new ActivityCheckpointError(key);
    const flow = new ExecutionFlowPath(MODEL_ACCESS_EXECUTION_FLOW, context.executionFlow ?? {}, activity.runId, [{ owner: "agent-runtime", kind: "model_activity", id: activity.id, revision: String(activity.version) },
    { owner: "model-interaction", kind: "request", id: request.requestId, revision: null }]);
    try {
      const step = flow.advance("binding", {
        activityId: activity.activityId, purpose: activity.purpose,
        owner: activity.owner.kind, inputOwner: activity.owner.inputOwner
      });
      step.output(flow.material("Model activity binding", "bound", activity, "execution", { owner: "agent-runtime", kind: "model_activity", id: activity.id, revision: String(activity.version) }));
      step.check("activity_scope", "passed");
      flow.advance("request", { requestId: request.requestId });
      // Existing product preparation keeps its own checkpoint authority until its
      // professional handlers migrate. Never give one preparation two journals.
      const journal = activity.owner.kind === "task_decision" ? this.journal : undefined;
      const stage = await journal?.bind(request,activity,context.retry.deadlineAt);
      const dispatched = stage && !stage.result ? await this.journal!.dispatch(stage,context.cancellation.signal,context.retry.deadlineAt) : null;
      let result: ProviderRequestSettlement;
      const retained = stage?.result?.value as ProviderRequestSettlement | RetainedActivityFailure | undefined;
      try {
        if (retained?.kind === "activity_failure") throw restoreActivityFailure(retained);
        result = retained ?? await this.send(request, activity, { ...context, executionFlow: flow.callContext }, requestNumber, delivery, dispatched?.granted ?? true);
      } catch (error) {
        if (journal && dispatched && error instanceof TaskDecisionActivityError && error.operationSettlement === "settled_failure") {
          await journal.save(dispatched.stage,{kind:"activity_failure",failure:error.failure,deadline:error.deadline} satisfies RetainedActivityFailure);
          await journal.accept(request,activity,{kind:"execution_failure_delivered",failure:error.failure});
        }
        if (journal && retained?.kind === "activity_failure") await journal.accept(request,activity,{kind:"execution_failure_delivered",failure:retained.failure});
        throw error;
      }
      if (dispatched) await journal!.save(dispatched.stage,result);
      flow.advance("result", { kind: result.kind, recipient: activity.owner.kind });
      flow.close("returned");
      return result;
    }
    catch (error) {
      flow.close(context.cancellation.signal.aborted ? "cancelled" : error instanceof RetryInvocationInvalidatedError ? "interrupted" : "failed");
      throw error;
    }
  }
  private async send(request: ProviderRequest, activity: ModelActivityBinding, callContext: AgentActivityExecutionContext, providerRequestNumber: number, delivery?: ModelResponseDelivery, dispatchGranted = true): Promise<ProviderRequestSettlement> {
    callContext.auxiliaryUsage?.assertAvailable();
    const records = new ModelActivityCheckpoint(callContext.checkpoints);
    const requestKey = JSON.stringify([request.requestId, request.continuation]);
    const operations = records.read<readonly {
      key: string;
      operation: RetryOperation;
    }[]>("provider-operations") ?? [];
    let operation = operations.find(entry => entry.key === requestKey)?.operation;
    if (!operation) {
      operation = createProviderRetryOperation(activity, callContext.retry.deadlineAt, callContext.checkpoints ? operations.length + 1 : providerRequestNumber, this.input.retryClock, callContext.auxiliaryInvocationId);
      await records.save("provider-operations", [...operations, { key: requestKey, operation }]);
    }
    await records.once(`provider-request:${requestKey}`, () => request);
    const retainedRequest = snapshotProviderRequest(records.read<ProviderRequest>(`provider-request:${requestKey}`) ?? request);
    if (createProviderSemanticRequestDigest(retainedRequest) !== createProviderSemanticRequestDigest(request)) {
      throw new ActivityCheckpointError(`provider-request:${requestKey}`);
    }
    request = retainedRequest;
    throwIfCancelled(callContext);
    if (Date.parse(operation.startedAt) >= Date.parse(callContext.retry.deadlineAt)) {
      throw operationDeadlineError(operation, operation.startedAt, 0, 0, null, this.input.provider.descriptor.id);
    }
    const budgetId = `${operation.operationId}:budget:1`;
    const auxiliaryUsage = (checkpoint: RetryCheckpoint<ProviderRequestSettlement, ProviderAttemptFailure, string> | null): import("./AuxiliaryModelUsage.js").AuxiliaryModelUsage | undefined => {
      if (!request.composition.lineage.auxiliary || !checkpoint?.attempt || !checkpoint.attemptResult || !checkpoint.attemptFinishedAt)
        return;
      const result = checkpoint.attemptResult;
      const response = result.kind === "succeeded" && result.value.kind === "response" ? result.value.response : null;
      const usage = response?.kind === "native_tool_turn" ? response.turn.usage : response?.usage ?? null;
      return {
        attemptId: checkpoint.attempt.attemptId, requestId: request.requestId,
        purpose: request.composition.lineage.auxiliary.purpose, outcome: result.kind, usage
      };
    };
    const retainedUsage = auxiliaryUsage(records.read<RetryCheckpoint<ProviderRequestSettlement, ProviderAttemptFailure, string>>(`retry:${operation.operationId}`));
    if (retainedUsage)
      await callContext.auxiliaryUsage?.record(retainedUsage);
    let result;
    const transport=(attempt:RetryAttemptContext)=>{
      const send=()=>this.input.provider.send(recreateProviderRequest(request),createInvocationInterruptionContext(callContext,attempt),
        delivery?.invocation(attempt.attempt.attemptId,request.requestId,attempt.signal)??{mode:"buffered",invocationId:attempt.attempt.attemptId});
      return this.transportJournal?.execute(request,activity,attempt.attempt.attemptId,callContext.retry.deadlineAt,attempt.signal,send)??send();
    };
    try {
      result = await this.input.retryExecutor.execute<ProviderRequestSettlement, ProviderAttemptFailure, string>({
        operation,
        budgetId,
        priorProgress: { completedAttempts: 0, totalRetryDelayMs: 0 },
        policy: callContext.retry.providerRequest,
        executionFlow: callContext.executionFlow,
        classifier: { classify: classifyProviderAttemptFailure },
        cancellation: callContext.cancellation,
        events: callContext.retry.events,
        waitControl: callContext.retry.waitControl,
      }, async (attempt) => {
        if (!dispatchGranted) throw new ActivityCheckpointError("provider_dispatch_already_accepted_without_recoverable_response");
        callContext.auxiliaryUsage?.assertAvailable();
        const providerResult=await transport(attempt);
        return providerAttemptResult(providerResult, callContext, attempt, this.input.retryClock);
      }, callContext.checkpoints ? {
        read: () => records.read<RetryCheckpoint<ProviderRequestSettlement, ProviderAttemptFailure, string>>(`retry:${operation.operationId}`),
        commit: async (checkpoint) => {
          const usage = auxiliaryUsage(checkpoint);
          await records.save(`retry:${operation.operationId}`, checkpoint, usage);
          if (usage && !callContext.checkpoints?.commitWithAuxiliaryUsage)
            await callContext.auxiliaryUsage?.record(usage);
        },
        reconcile: async (attempt) => {
          const restored=await this.transportJournal?.restore(request,activity,attempt.attempt.attemptId);
          if(restored)return providerAttemptResult(restored,callContext,attempt,this.input.retryClock);
          // Absence of a physical dispatch is recoverable under the same attempt.
          // An accepted dispatch without a confirmed result throws above instead.
          if(this.transportJournal)return providerAttemptResult(await transport(attempt),callContext,attempt,this.input.retryClock);
          return ({
          kind: "failed", error: {
            deadlineReason: null, failure: {
              code: "provider_attempt_interrupted", category: "transport", message: "The interrupted Provider attempt has no retained complete response.",
              metadata: { requestId: request.requestId, usage: "unknown" }, requestId: request.requestId,
            }
          }
          });
        },
      } : undefined);
    }
    catch (error) {
      assertControllerCheckpointConfirmed(error);
      if (error instanceof RetryInvocationInvalidatedError)
        throw error;
      if (callContext.cancellation.signal.aborted) {
        throw providerCancellationUnconfirmedError("Provider request did not confirm the active Run cancellation.", this.input.provider.descriptor.id, errorMetadata(error));
      }
      throw createControllerError("provider", "provider_request_failed", "Provider request failed.", false, {
        providerId: this.input.provider.descriptor.id,
        ...errorMetadata(error),
      });
    }
    switch (result.kind) {
      case "succeeded":
        if (result.value.kind === "response" && result.value.response.kind === "native_tool_turn") {
          const turn = result.value.response.turn;
          if (turn.responseRef.requestId !== request.requestId ||
            turn.responseRef.providerId !== this.input.provider.descriptor.id ||
            turn.assistant.content.some(block => block.kind === "model_tool_call" && (block.call.modelCallRef.controllerRequestId !== request.correlation.controllerRequestId ||
              block.call.modelCallRef.branchId !== request.correlation.branchId))) {
            throw invalidOutput("Provider Model Turn does not correlate to the actual request.");
          }
        }
        return result.value;
      case "failed":
        throw providerRetryFailureError(result.failure, this.input.provider.descriptor.id);
      case "cancelled":
        throw callContext.cancellation.signal.reason;
      case "budget_exhausted":
        await callContext.retry.events.emit(retryBudgetExhaustedEvent(operation, result.exhaustion.budgetId, result.exhaustion.progress.completedAttempts, result.exhaustion.progress.totalRetryDelayMs, result.exhaustion.lastFailure, result.exhaustion.exhaustedAt));
        throw providerRetryExhaustedError("retry_budget_exhausted", result.exhaustion.operationId, result.exhaustion.progress.completedAttempts, result.exhaustion.progress.totalRetryDelayMs, result.exhaustion.lastFailure, this.input.provider.descriptor.id);
      case "deadline_exhausted":
        throw operationDeadlineError(operation, result.exhaustion.exhaustedAt, result.exhaustion.totalAttempts, result.exhaustion.totalRetryDelayMs, result.exhaustion.lastFailure, this.input.provider.descriptor.id);
    }
  }
}
type ProviderRetryCategory = "transport" | "timeout" | "rate_limit" | "server_error" | "deadline" | "authentication" | "invalid_request" | "response" | "cancellation" | "provider";
interface ProviderAttemptFailure {
  readonly failure: ProviderFailure;
  readonly deadlineReason: RetryAttemptContext["deadlineReason"];
}
type ProviderRequestSettlement = {
  readonly kind: "response";
  readonly response: ProviderResponse;
} | {
  readonly kind: "continuation_rejected";
  readonly continuationId: string;
  readonly providerCode: string | null;
};
interface RetainedActivityFailure {
  readonly kind: "activity_failure";
  readonly failure: TaskDecisionActivityFailure;
  readonly deadline: DecisionActivityDeadline | null;
}
function restoreActivityFailure(value: RetainedActivityFailure): TaskDecisionActivityError {
  return new TaskDecisionActivityError(value.failure,"settled_failure",value.deadline);
}
function throwIfCancelled(context: AgentActivityExecutionContext): void {
  if (context.cancellation.signal.aborted) {
    throw context.cancellation.signal.reason;
  }
}
function invalidOutput(message: string, metadata: Readonly<Record<string, unknown>> = {}): TaskDecisionActivityError {
  return createControllerError("model", "model_output_invalid", message, false, metadata);
}
function createControllerError(owner: TaskDecisionActivityFailure["kind"], code: TaskDecisionActivityFailureCode, message: string, retryable: boolean, metadata: Readonly<Record<string, unknown>>, operationSettlement: "unsettled" | "settled_failure" = "unsettled", providerCategory?: string, deadline: DecisionActivityDeadline | null = null): TaskDecisionActivityError {
  const frozenMetadata = Object.freeze({ ...metadata });
  return new TaskDecisionActivityError(owner === "model"
    ? Object.freeze({
      kind: "model" as const,
      failure: Object.freeze({
        code,
        message,
        retryable,
        metadata: frozenMetadata,
      }),
    })
    : Object.freeze({
      kind: "provider" as const,
      failure: Object.freeze({
        ...snapshotProviderFailure({category: providerCategory ?? providerFailureCategory(code), code, message, metadata: frozenMetadata}),
        code,
      }),
    }), operationSettlement, deadline);
}
function providerFailureCategory(code: TaskDecisionActivityFailureCode): string {
  if (code === "provider_timeout")
    return "timeout";
  if (code === "provider_cancellation_unconfirmed")
    return "cancellation";
  if (code === "provider_retry_exhausted")
    return "retry_exhausted";
  return "provider";
}
function createInvocationInterruptionContext(context: AgentActivityExecutionContext, attempt: RetryAttemptContext): InvocationInterruptionContext {
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
function providerAttemptResult(result: ProviderCallResult, context: AgentActivityExecutionContext, attempt: RetryAttemptContext, clock: RetryClock) {
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
      return {
        kind: "succeeded" as const,
        value: Object.freeze({
          kind: "response" as const,
          response: result.response,
        }),
      };
    case "continuation_rejected":
      return {
        kind: "succeeded" as const,
        value: Object.freeze({
          kind: "continuation_rejected" as const,
          continuationId: result.continuationId,
          providerCode: result.providerCode,
        }),
      };
    case "failed":
      return {
        kind: "failed" as const,
        error: { failure: retainedProviderFailure(result.failure), deadlineReason: attempt.deadlineReason },
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
          failure: providerCancellationFailure("Provider returned cancellation without the active Run correlation.", result.cancellation.requestId),
          deadlineReason: null,
        },
      };
    case "cancellation_unconfirmed":
      return {
        kind: "failed" as const,
        error: { failure: retainedProviderFailure(result.failure), deadlineReason: null },
      };
  }
}
function retainedProviderFailure(failure: unknown): ProviderFailure {
  try { return snapshotProviderFailure(failure); }
  catch (error) {
    return snapshotProviderFailure({category: "response", code: "provider_result_contract_invalid",
      message: "Provider returned a failure that does not satisfy the result contract.",
      metadata: {diagnostic: error instanceof Error ? error.message.slice(0, 1024) : "Invalid Provider failure"}});
  }
}
function classifyProviderAttemptFailure(error: ProviderAttemptFailure): RetryClassification<ProviderRetryCategory> {
  const failure = error.failure;
  if (failure.code === "provider_attempt_interrupted") return classification(failure, "transport", "non_retryable");
  if (error.deadlineReason !== null &&
    failure.code === "provider_operation_deadline") {
    return classification(failure, "deadline", "deadline_exceeded");
  }
  if (failure.code === "provider_cancellation_unconfirmed" ||
    failure.category === "cancellation") {
    return classification(failure, "cancellation", "non_retryable");
  }
  if (failure.category === "timeout" ||
    failure.code === "provider_timeout" ||
    failure.statusCode === 408) {
    return classification(failure, "timeout", "retryable");
  }
  if (failure.category === "rate_limit" || failure.statusCode === 429) {
    return classification(failure, "rate_limit", "retryable");
  }
  if (failure.category === "server_error" ||
    failure.statusCode !== undefined &&
    failure.statusCode >= 500 &&
    failure.statusCode <= 599) {
    return classification(failure, "server_error", "retryable");
  }
  if (failure.category === "transport") {
    return classification(failure, "transport", "retryable");
  }
  if (failure.category === "authentication" ||
    failure.statusCode === 401 ||
    failure.statusCode === 403) {
    return classification(failure, "authentication", "non_retryable");
  }
  if (failure.category === "response" ||
    failure.code === "provider_response_malformed" ||
    failure.code === "provider_response_too_large") {
    return classification(failure, "response", "non_retryable");
  }
  if (failure.code === "provider_context_window_exceeded") {
    return classification(failure, "invalid_request", "non_retryable");
  }
  if (failure.category === "invalid_request" ||
    failure.statusCode !== undefined && failure.statusCode >= 400) {
    return classification(failure, "invalid_request", "non_retryable");
  }
  return classification(failure, "provider", "non_retryable");
}
function classification(failure: ProviderFailure, category: ProviderRetryCategory, disposition: RetryClassification<ProviderRetryCategory>["disposition"]): RetryClassification<ProviderRetryCategory> {
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
function createProviderRetryOperation(input: ModelActivityBinding, deadlineAt: string, providerRequestNumber: number, clock: RetryClock, auxiliaryInvocationId?: string): RetryOperation {
  const controllerRequestId = auxiliaryInvocationId ?? input.activityId;
  return Object.freeze({
    operationId: `${controllerRequestId}:provider-request:${providerRequestNumber}`,
    owner: "provider_request",
    runId: input.runId,
    subject: Object.freeze({ kind: "provider_request", controllerRequestId }),
    startedAt: retryNow(clock),
    deadlineAt,
  });
}
function providerCancellationAttribution(context: AgentActivityExecutionContext, clock: RetryClock) {
  const request = context.cancellation.request;
  if (!context.cancellation.signal.aborted || request === null) {
    throw new TypeError("Provider cancellation requires the active Run request.");
  }
  return Object.freeze({
    requestId: request.id,
    runId: request.runId,
    operation: "provider" as const,
    observedAt: retryNow(clock),
  });
}
function providerOperationDeadlineFailure(deadline: NonNullable<RetryAttemptContext["deadlineReason"]>): ProviderFailure {
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
function retryBudgetExhaustedEvent(operation: RetryOperation, budgetId: string, totalAttempts: number, totalRetryDelayMs: number, lastFailure: RetryFailure, occurredAt: string): RetryExhaustedEvent {
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
function retryNow(clock: RetryClock): string {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("RetryClock.now() must return a valid Date.");
  }
  return value.toISOString();
}
function matchesActiveCancellation(candidate: {
  readonly runId: string;
  readonly requestId: string;
}, context: AgentActivityExecutionContext): boolean {
  const request = context.cancellation.request;
  return context.cancellation.signal.aborted &&
    request !== null &&
    candidate.runId === request.runId &&
    candidate.requestId === request.id;
}
function providerRetryFailureError(failure: RetryFailure, providerId: string): TaskDecisionActivityError {
  const code: Extract<TaskDecisionActivityFailureCode, "provider_context_window_exceeded" | "provider_request_failed" | "provider_timeout" | "provider_cancellation_unconfirmed"> = failure.code === "provider_cancellation_unconfirmed"
    ? "provider_cancellation_unconfirmed"
    : failure.code === "provider_context_window_exceeded"
      ? "provider_context_window_exceeded"
      : failure.category === "timeout" || failure.code === "provider_timeout"
        ? "provider_timeout"
        : "provider_request_failed";
  return createControllerError("provider", code, failure.message, false, {
    providerId,
    providerFailureCategory: failure.category,
    providerErrorCode: failure.code,
    providerRequestId: failure.requestId ?? null,
    providerStatusCode: failure.statusCode ?? null,
    providerRetryAfterMs: failure.retryAfterMs ?? null,
  }, failure.code === "provider_attempt_interrupted" ? "unsettled" : "settled_failure", failure.category);
}
function providerRetryExhaustedError(reason: "retry_budget_exhausted", operationId: string, totalAttempts: number, totalRetryDelayMs: number, lastFailure: RetryFailure | null, providerId: string): TaskDecisionActivityError {
  return createControllerError("provider", "provider_retry_exhausted", "Provider request Retry was exhausted.", false, {
    providerId,
    retryOperationId: operationId,
    retryExhaustionReason: reason,
    retryTotalAttempts: totalAttempts,
    retryTotalDelayMs: totalRetryDelayMs,
    providerFailureCategory: lastFailure?.category ?? null,
    providerErrorCode: lastFailure?.code ?? null,
    providerRequestId: lastFailure?.requestId ?? null,
    providerStatusCode: lastFailure?.statusCode ?? null,
  }, "settled_failure");
}
function operationDeadlineError(operation: RetryOperation, exhaustedAt: string, totalAttempts: number, totalRetryDelayMs: number, lastFailure: RetryFailure | null, providerId?: string): TaskDecisionActivityError {
  if (operation.deadlineAt === undefined ||
    (operation.owner !== "provider_request" && operation.owner !== "structured_output")) {
    throw new TypeError("Controller deadline exhaustion requires its logical operation deadline.");
  }
  const provider = operation.owner === "provider_request";
  return createControllerError(provider ? "provider" : "model", provider ? "provider_operation_deadline_exceeded" : "model_operation_deadline_exceeded", "The Controller operation cannot continue within its assigned deadline.", false, {
    retryOperationId: operation.operationId,
    retryExhaustionReason: "deadline_exceeded",
    retryTotalAttempts: totalAttempts,
    retryTotalDelayMs: totalRetryDelayMs,
    deadlineAt: operation.deadlineAt,
    exhaustedAt,
    ...(provider ? { providerId: providerId ?? null } : {}),
    lastFailure,
  }, "settled_failure", provider ? "deadline" : undefined, Object.freeze({ operationId: operation.operationId, owner: operation.owner, deadlineAt: operation.deadlineAt, exhaustedAt }));
}
function providerCancellationUnconfirmedError(message: string, providerId: string, metadata: Readonly<Record<string, unknown>>): TaskDecisionActivityError {
  return createControllerError("provider", "provider_cancellation_unconfirmed", message, false, { providerId, ...metadata }, "settled_failure");
}
function errorMetadata(error: unknown): Readonly<Record<string, unknown>> {
  if (!(error instanceof Error)) {
    return {};
  }
  const code = "code" in error && typeof error.code === "string" ? error.code : null;
  return {
    causeName: error.name,
    causeCode: code,
  };
}
function recreateProviderRequest(request: ProviderRequest): ProviderRequest {
  return snapshotProviderRequest(request);
}
function assertControllerCheckpointConfirmed(error: unknown): void {
  if (error instanceof ActivityCheckpointError || error instanceof RetryCheckpointError)
    throw error;
}
