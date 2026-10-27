import { snapshotProviderFailure } from "@agent-anything/model-interaction";
import { ContextRepresentationManager } from "../context-representation/ContextRepresentationManager.js";
import { ModelRequestAccess } from "../model-access/ModelRequestAccess.js";
import { recordContinuedModelInput, type AcceptedActivityContinuationRef } from "../model-access/ModelInputContinuation.js";
import { createModelActivityBinding } from "../model-access/ModelActivityBinding.js";
import { ModelResponseTaskDecisionMaker } from "../decision/ModelResponseTaskDecisionMaker.js";
import { ActivityContinuationCoordinator, createActivityContinuationArrangement, type ActivityContinuationCause } from "./ActivityContinuation.js";
import { ACTIVITY_CONTINUATION_FLOW } from "./ActivityContinuationFlow.js";
export { snapshotTaskDecisionFeedback, validateTaskDecisionProposal } from "../decision/TaskDecisionValidation.js";
import { RetryInvocationInvalidatedError } from "../retry/RetryWaitControl.js";
import { ModelResponseDelivery, type ModelResponseDeliveryOptions } from "../model-access/ModelResponseObservation.js";
import { ExecutionFlowPath, type ExecutionFlowContext } from "@agent-anything/observability/execution-flow";
import { MODEL_TURN_EXECUTION_FLOW } from "../decision/ModelTurnExecutionFlow.js";
import { freezePreparedProviderRequest, type ContextRepresentationPreparationSupport } from "../context-representation/ContextRepresentationPreparation.js";
import { observeModelInputUsage, type ModelInputPlanning } from "@agent-anything/model-interaction/context";
import { createProviderInputDeliveryReceipt, type ControllerInputDeliveryReceipt } from "../decision/DecisionInputDelivery.js";
import { createConversationOpeningReceipt, type ConversationOpeningReceipt } from "../decision/TaskConversation.js";
import type { Provider, ProviderRequest, ProviderResponse } from "@agent-anything/model-interaction";
import { snapshotProviderRequest } from "@agent-anything/model-interaction";
import { modelInputValueDigest } from "@agent-anything/model-interaction/input";
import { ModelContinuationLifecycle, type ModelContinuationPreparation, type ModelContinuationRequestLineage, } from "@agent-anything/model-interaction/continuation";
import type { RetryAttemptContext, RetryClock } from "../retry/index.js";
import { RetryExecutor } from "../retry/RetryExecutor.js";
import { RetryCheckpointError, type RetryCheckpoint } from "../retry/RetryCheckpoint.js";
import { ActivityCheckpointError } from "../activity/ActivityCheckpoint.js";
import { ModelActivityCheckpoint } from "../model-access/ModelActivityCheckpoint.js";
import type { RetryClassification, RetryFailure } from "../retry/index.js";
import type { RetryExhaustedEvent } from "../retry/index.js";
import type { RetryOperation } from "../retry/index.js";
import { TaskDecisionActivityError, type TaskDecisionActivityFailure, type TaskDecisionActivityFailureCode, type DecisionActivityDeadline } from "../decision/TaskDecisionActivityError.js";
export { TaskDecisionActivityError, type TaskDecisionActivityFailure, type TaskDecisionActivityFailureCode, type DecisionActivityDeadline } from "../decision/TaskDecisionActivityError.js";
import { type ModelOutputRecovery } from "../decision/ModelOutputRecovery.js";
import type { ModelInputRecoveryPort } from "../context-representation/ModelInputRecovery.js";
import type { TaskDecisionActivity, AgentActivityExecutionContext, TaskDecisionProposal, TaskDecisionInputSources } from "../decision/TaskDecisionActivity.js";
import { StructuredOutputError, snapshotStructuredOutputFailure, type ProviderRequestBuildContext, type StructuredOutputFailure, type StructuredOutputFailureCategory, } from "../decision/StructuredOutput.js";
export type BuildProviderRequest<TOutput = unknown> = (input: TaskDecisionInputSources<TOutput>, context: ProviderRequestBuildContext) => ProviderRequest | Promise<ProviderRequest>;
export type ParseProviderResponse<TOutput = unknown> = (response: ProviderResponse, input: TaskDecisionInputSources<TOutput>, executionFlow?: ExecutionFlowContext) => TaskDecisionProposal<TOutput> | Promise<TaskDecisionProposal<TOutput>>;
export interface ModelTaskDecisionCoordinatorOptions<TOutput = unknown> {
  readonly provider: Provider;
  readonly buildRequest: BuildProviderRequest<TOutput>;
  readonly parseResponse: ParseProviderResponse<TOutput>;
  readonly responseProtocol: {
    readonly kind: "structured_output";
    readonly contractId: string;
    readonly maxProviderOutputLength: number;
  } | {
    readonly kind: "native_tool_turn";
    readonly maximumOutputRecoveryAttempts?: number;
  };
  readonly retryExecutor: RetryExecutor;
  readonly retryClock: RetryClock;
  readonly continuation?: ModelContinuationLifecycle;
  readonly modelInputRecovery?: ModelInputRecoveryPort;
  readonly contextPreparation?: ContextRepresentationPreparationSupport;
  readonly delivery?: ModelResponseDeliveryOptions;
}
type ProviderRequestSettlement = {
  readonly kind: "response";
  readonly response: ProviderResponse;
} | {
  readonly kind: "continuation_rejected";
  readonly continuationId: string;
  readonly providerCode: string | null;
};
type StructuredOutputRetryCategory = StructuredOutputFailureCategory | "deadline" | "owner_failure";
type StructuredOutputAttemptFailure = {
  readonly kind: "correction";
  readonly failure: StructuredOutputFailure;
} | {
  readonly kind: "deadline";
  readonly operationId: string;
  readonly deadlineAt: string;
} | {
  readonly kind: "terminal";
  readonly error: unknown;
};
export class ModelTaskDecisionCoordinator<TOutput = unknown> implements TaskDecisionActivity<TOutput> {
  readonly preparations: import("../context-representation/ContextPreparationLifecycle.js").ContextPreparationLifecycle;
  private readonly representations: ContextRepresentationManager<TOutput>;
  private readonly modelAccess: ModelRequestAccess;
  private readonly taskDecisionMaker: ModelResponseTaskDecisionMaker<TOutput>;
  private readonly continuation: ModelContinuationLifecycle;
  get resourceMetering(): TaskDecisionActivity<TOutput>["resourceMetering"] {
    const usage = this.input.provider.descriptor.capabilities.usageMetering;
    return Object.freeze({
      modelInputTokens: usage.inputTokens,
      modelOutputTokens: usage.outputTokens,
      costUnits: usage.costUnits,
    });
  }
  constructor(private readonly input: ModelTaskDecisionCoordinatorOptions<TOutput>) {
    this.modelAccess = new ModelRequestAccess(input);
    this.representations = new ContextRepresentationManager(input);
    this.preparations = {
      resume: (runId, context) => this.representations.resumeBackground(runId, context, async (request, activityContext) => {
        const auxiliary = request.composition.lineage.auxiliary;
        if (!auxiliary || !activityContext.auxiliaryInvocationId)
          throw new TypeError("Background model access requires its registered activity.");
        const activity = createModelActivityBinding({
          runId, activityId: activityContext.auxiliaryInvocationId,
          purpose: request.purpose, owner: { kind: auxiliary.purpose, inputOwner: "activity" }
        });
        const result = await this.modelAccess.execute(request, activityContext, 1, activity);
        if (result.kind !== "response")
          throw new TypeError("Auxiliary model access cannot use continuation.");
        return result.response;
      })
    };
    this.taskDecisionMaker = new ModelResponseTaskDecisionMaker(input.responseProtocol, input.parseResponse);
    if (input.responseProtocol.kind === "native_tool_turn") {
      const maximum = input.responseProtocol.maximumOutputRecoveryAttempts ?? 2;
      if (!Number.isSafeInteger(maximum) || maximum < 0) {
        throw new TypeError("maximumOutputRecoveryAttempts must be a non-negative safe integer.");
      }
    }
    if (input.delivery?.mode === "streaming" &&
      (input.responseProtocol.kind !== "native_tool_turn" || !input.provider.descriptor.capabilities.streaming.supported)) {
      throw new TypeError("Streaming requires native Tool interaction and a streaming-capable Provider.");
    }
    this.continuation = input.continuation ?? new ModelContinuationLifecycle();
    if (typeof input.retryExecutor?.execute !== "function") {
      throw new TypeError("ModelTaskDecisionCoordinator requires a RetryExecutor.");
    }
    if (typeof input.retryClock?.now !== "function") {
      throw new TypeError("ModelTaskDecisionCoordinator requires a RetryClock.");
    }
    if (input.responseProtocol.kind === "structured_output") {
      if (!Number.isInteger(input.responseProtocol.maxProviderOutputLength) ||
        input.responseProtocol.maxProviderOutputLength <= 0) {
        throw new TypeError("maxProviderOutputLength must be a positive integer.");
      }
      if (typeof input.responseProtocol.contractId !== "string" ||
        input.responseProtocol.contractId.trim().length === 0) {
        throw new TypeError("ModelTaskDecisionCoordinator requires a structured-output contract id.");
      }
    }
    if (input.provider.descriptor.requestRetryScheduler?.kind !== "harness") {
      throw new TypeError("ModelTaskDecisionCoordinator requires Harness-owned Provider request Retry.");
    }
  }
  async next(controllerInput: TaskDecisionInputSources<TOutput>, callContext: AgentActivityExecutionContext): Promise<TaskDecisionProposal<TOutput>> {
    const activityContext = callContext;
    callContext = {
      ...callContext, acceptInputRepreparation: input => this.acceptContinuation(input, controllerInput, activityContext, input.sequence, input.maximum, {
        kind: "capacity_rejection", location: input.location, code: input.location === "provider"
          ? "provider_context_window_exceeded" : "model_context_capacity_exceeded"
      }, null)
    };
    const flow = new ExecutionFlowPath(MODEL_TURN_EXECUTION_FLOW, callContext.executionFlow ?? {}, controllerInput.runId, []);
    try {
      throwIfCancelled(callContext);
      await new ModelActivityCheckpoint(callContext.checkpoints).bind({
        target: this.input.provider.modelContext.target, requestedOutput: this.input.provider.modelContext.requestedOutput,
        protocol: this.input.responseProtocol.kind === "native_tool_turn"
          ? { kind: "native_tool_turn", maximumOutputRecoveryAttempts: this.input.responseProtocol.maximumOutputRecoveryAttempts ?? 2 }
          : this.input.responseProtocol,
        controllerRequestId: controllerInput.toolExposure.controllerRequestId,
      });
      const decision = this.input.responseProtocol.kind === "native_tool_turn"
        ? await this.executeNativeToolTurn(controllerInput, callContext, flow)
        : await this.executeStructuredOutput(controllerInput, callContext, flow);
      throwIfCancelled(callContext);
      flow.current?.output(flow.material("Validated Controller decision", "validated", decision));
      flow.close("returned");
      return decision;
    }
    catch (error) {
      flow.close(callContext.cancellation.signal.aborted ? "cancelled" : error instanceof RetryInvocationInvalidatedError ? "interrupted" : "failed");
      throw error;
    }
  }
  async recover(input: TaskDecisionInputSources<TOutput>, context: AgentActivityExecutionContext): Promise<TaskDecisionProposal<TOutput>> {
    if (!context.checkpoints || this.input.provider.descriptor.capabilities.continuation.supported) {
      throw new ActivityCheckpointError("provider_continuation_recovery_unavailable");
    }
    return this.next(input, context);
  }
  private async executeNativeToolTurn(controllerInput: TaskDecisionInputSources<TOutput>, callContext: AgentActivityExecutionContext, flow: ExecutionFlowPath): Promise<TaskDecisionProposal<TOutput>> {
    const delivery = new ModelResponseDelivery(controllerInput.runId, controllerInput.toolExposure.controllerRequestId, this.input.delivery ?? { mode: "buffered" });
    let providerRequestNumber = 0;
    let outputRecovery: ModelOutputRecovery | undefined;
    let acceptedContinuation: AcceptedActivityContinuationRef | undefined;
    const maximumRecoveryAttempts = this.input.responseProtocol.kind === "native_tool_turn"
      ? this.input.responseProtocol.maximumOutputRecoveryAttempts ?? 2 : 0;
    try {
      for (let recoveryAttempt = 0;;recoveryAttempt++) {
        throwIfCancelled(callContext);
        const build = flow.advance("build", { controllerRequestId: controllerInput.toolExposure.controllerRequestId }, [{ owner: "runtime", kind: "request", id: controllerInput.toolExposure.controllerRequestId, revision: null }]);
        const request = snapshotProviderRequest(await new ModelActivityCheckpoint(callContext.checkpoints)
          .once(`native-request:${recoveryAttempt}`, () => this.buildRequest(controllerInput, Object.freeze({
            executionFlow: flow.callContext,
            attemptNumber: recoveryAttempt + 1,
            correction: null,
            target: this.input.provider.modelContext.target,
            requestedOutput: this.input.provider.modelContext.requestedOutput,
            ...(outputRecovery ? { outputRecovery } : {}),
          }))));
        if (acceptedContinuation) recordContinuedModelInput(acceptedContinuation, request, flow.callContext);
        build.check("request_contract", "passed", { requestId: request.requestId, compositionId: request.composition.id });
        const requestRef = flow.material("Composed Provider request", "composed", request, "provider");
        build.output(requestRef);
        const send = flow.advance("send", { requestId: request.requestId }, [requestRef]);
        const { response, actualRequest, inputDeliveryReceipt, openingReceipt, contextPlanning, workingForms, workingAccounts } = await this.sendRequest(request, controllerInput, { ...callContext, executionFlow: flow.callContext }, () => ++providerRequestNumber, 0, delivery);
        const responseRef = flow.material("Normalized Provider response", "received", response, "provider");
        send.output(responseRef);
        if (response.kind !== "native_tool_turn") {
          throw invalidOutput("Provider returned a response kind that does not match native Tool interaction.");
        }
        const parse = flow.advance("parse", {}, [responseRef]);
        throwIfCancelled(callContext);
        parse.check("output_complete", response.turn.finish.kind === "output_limit" ? "not_satisfied" : "passed", { finish: response.turn.finish.kind, recoveryAttempt, maximumRecoveryAttempts });
        if (response.turn.finish.kind === "output_limit") {
          delivery.finish("rejected");
          parse.check("decision_contract", "not_evaluated", { reason: "output_limit" });
          if (recoveryAttempt >= maximumRecoveryAttempts) {
            throw createControllerError("model", "model_output_limit_exhausted", (request.modelContext.requestedOutput.maximum === null
              ? "The Provider reported that model output reached a length limit "
              : `Model output was truncated at the configured ${request.modelContext.requestedOutput.maximum}-token limit `) +
              `after ${recoveryAttempt + 1} generation attempts. No calls from the truncated responses were executed.`, false, {
              finishKind: "output_limit", requestId: response.turn.responseRef.requestId,
              responseId: response.turn.responseRef.responseId, turnId: response.turn.turnId,
              maximumOutputTokens: request.modelContext.requestedOutput.maximum,
              generationAttempts: recoveryAttempt + 1, recoveryAttempts: recoveryAttempt,
            }, "settled_failure");
          }
          outputRecovery = Object.freeze({
            sourceRequestId: response.turn.responseRef.requestId,
            turnId: response.turn.turnId,
            attemptNumber: recoveryAttempt + 1,
            requestedOutput: request.modelContext.requestedOutput,
          });
          acceptedContinuation = await this.acceptContinuation(actualRequest, controllerInput, callContext, recoveryAttempt + 1, maximumRecoveryAttempts, { kind: "protocol_correction", code: "model_output_truncated", feedback: outputRecovery }, response.turn.responseRef.responseId);
          continue;
        }
        const parsed = await this.parseResponse(response, controllerInput, actualRequest, callContext, flow.callContext);
        const decision = withInputUsageObservation(parsed, contextPlanning, workingForms, workingAccounts);
        parse.check("decision_contract", "passed", { kind: decision.kind });
        throwIfCancelled(callContext);
        delivery.finish("validated", decision.modelItems);
        return Object.freeze({
          ...decision, ...(inputDeliveryReceipt === null ? {} : { inputDeliveryReceipt }),
          ...(openingReceipt === null ? {} : { openingReceipt })
        });
      }
    }
    catch (error) {
      delivery.finish(callContext.cancellation.signal.aborted ? "cancelled"
        : error instanceof RetryInvocationInvalidatedError ? "interrupted" : "rejected");
      throw error;
    }
  }
  private async executeStructuredOutput(controllerInput: TaskDecisionInputSources<TOutput>, callContext: AgentActivityExecutionContext, flow: ExecutionFlowPath): Promise<TaskDecisionProposal<TOutput>> {
    const records = new ModelActivityCheckpoint(callContext.checkpoints);
    const operation = await records.once("structured-operation", () => createStructuredOutputRetryOperation(controllerInput, this.requireStructuredOutputProtocol().contractId, callContext.retry.deadlineAt, this.input.retryClock));
    const budgetId = `${operation.operationId}:budget:1`;
    let correction: ProviderRequestBuildContext["correction"] = null;
    let responseSource: {
      requestId: string;
      purpose: string;
      responseId: string | null;
    } | null = null;
    let providerRequestNumber = 0;
    let result;
    const retryKey = `retry:${operation.operationId}`;
    const readRetry = () => decodeStructuredRetry<TOutput>(records.read(retryKey));
    const saved = readRetry();
    if (saved?.attemptResult?.kind === "failed" && saved.attemptResult.error.kind === "correction") {
      correction = { previousAttemptNumber: saved.attempt!.attemptNumber, failure: saved.attemptResult.error.failure };
    }
    try {
      const executeAttempt = async (attempt: RetryAttemptContext) => {
        const interruptedBeforeBuild = structuredOutputInterruption(attempt, callContext, this.input.retryClock);
        if (interruptedBeforeBuild !== null) {
          return interruptedBeforeBuild;
        }
        const build = flow.advance("build", { attemptNumber: attempt.attempt.attemptNumber });
        let acceptedContinuation: AcceptedActivityContinuationRef | undefined;
        if (correction !== null) {
          const prior = callContext.checkpoints
            ? records.read<NonNullable<typeof responseSource>>(`structured-response-source:${correction.previousAttemptNumber}`)
            : responseSource;
          if (!prior)
            throw new ActivityCheckpointError("structured_correction_source_unavailable");
          const extra = callContext.retry.structuredOutput.exhaustion;
          acceptedContinuation = await this.acceptContinuation(prior, controllerInput, callContext, attempt.attempt.attemptNumber - 1, callContext.retry.structuredOutput.maxRetries + (extra?.kind === "retry_after_delay" ? extra.maxAdditionalAttempts : 0), { kind: "protocol_correction", code: correction.failure.code, feedback: correction }, prior.responseId);
        }
        const buildContext = Object.freeze({
          executionFlow: flow.callContext,
          attemptNumber: attempt.attempt.attemptNumber,
          correction,
          target: this.input.provider.modelContext.target,
          requestedOutput: this.input.provider.modelContext.requestedOutput,
        });
        let request: ProviderRequest;
        try {
          request = snapshotProviderRequest(await records.once(`structured-request:${attempt.attempt.attemptNumber}`, () => this.buildRequest(controllerInput, buildContext)));
          if (acceptedContinuation) recordContinuedModelInput(acceptedContinuation, request, flow.callContext);
          build.check("request_contract", "passed", { requestId: request.requestId, compositionId: request.composition.id });
        }
        catch (error) {
          assertControllerCheckpointConfirmed(error);
          return terminalStructuredOutputFailure(error);
        }
        const interruptedBeforeProvider = structuredOutputInterruption(attempt, callContext, this.input.retryClock);
        if (interruptedBeforeProvider !== null) {
          return interruptedBeforeProvider;
        }
        let response: ProviderResponse;
        let actualRequest: ProviderRequest;
        let inputDeliveryReceipt: ControllerInputDeliveryReceipt | null;
        let openingReceipt: ConversationOpeningReceipt | null;
        let contextPlanning: ModelInputPlanning | null;
        let workingForms: readonly import("@agent-anything/model-interaction/input").ModelInputOwnerForm[] | undefined;
        let workingAccounts: readonly import("@agent-anything/model-interaction/input").ModelInputAccount[] | undefined;
        const requestRef = flow.material("Composed Provider request", "composed", request, "provider");
        build.output(requestRef);
        try {
          flow.advance("send", { requestId: request.requestId }, [requestRef]);
          ({ response, actualRequest, inputDeliveryReceipt, openingReceipt, contextPlanning, workingForms, workingAccounts } = await this.sendRequest(request, controllerInput, { ...callContext, executionFlow: flow.callContext }, () => {
            providerRequestNumber += 1;
            return providerRequestNumber;
          }));
          responseSource = await records.once(`structured-response-source:${attempt.attempt.attemptNumber}`, () => ({
            requestId: actualRequest.requestId, purpose: actualRequest.purpose,
            responseId: response.kind === "native_tool_turn" ? response.turn.responseRef.responseId : response.responseId
          }));
        }
        catch (error) {
          assertControllerCheckpointConfirmed(error);
          if (matchesActiveCancellationError(error, callContext)) {
            return {
              kind: "cancelled" as const,
              attribution: controllerCancellationAttribution(callContext, this.input.retryClock),
            };
          }
          if (error instanceof RetryInvocationInvalidatedError)
            throw error;
          return terminalStructuredOutputFailure(error);
        }
        const interruptedBeforeParsing = structuredOutputInterruption(attempt, callContext, this.input.retryClock);
        if (interruptedBeforeParsing !== null) {
          return interruptedBeforeParsing;
        }
        try {
          const responseRef = flow.material("Normalized Provider response", "received", response, "provider");
          flow.current?.output(responseRef);
          const parse = flow.advance("parse", {}, [responseRef]);
          const parsed = await this.parseResponse(response, controllerInput, actualRequest, callContext, flow.callContext);
          const decision = withInputUsageObservation(parsed, contextPlanning, workingForms, workingAccounts);
          parse.check("decision_contract", "passed", { kind: decision.kind });
          const interruptedAfterValidation = structuredOutputInterruption(attempt, callContext, this.input.retryClock);
          return interruptedAfterValidation ?? {
            kind: "succeeded" as const,
            value: Object.freeze({
              ...decision, ...(inputDeliveryReceipt === null ? {} : { inputDeliveryReceipt }),
              ...(openingReceipt === null ? {} : { openingReceipt })
            }),
          };
        }
        catch (error) {
          if (error instanceof StructuredOutputError) {
            const interruptedDuringValidation = structuredOutputInterruption(attempt, callContext, this.input.retryClock);
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
      };
      result = await this.input.retryExecutor.execute({
        operation, budgetId, priorProgress: { completedAttempts: 0, totalRetryDelayMs: 0 },
        policy: callContext.retry.structuredOutput, classifier: { classify: classifyStructuredOutputAttemptFailure },
        cancellation: callContext.cancellation, events: callContext.retry.events,
        waitControl: callContext.retry.waitControl, executionFlow: callContext.executionFlow,
      }, executeAttempt, callContext.checkpoints ? {
        read: readRetry,
        commit: checkpoint => records.save(retryKey, encodeStructuredRetry(checkpoint)),
        reconcile: executeAttempt,
      } : undefined);
    }
    catch (error) {
      assertControllerCheckpointConfirmed(error);
      if (error instanceof RetryInvocationInvalidatedError)
        throw error;
      throw createControllerError("model", "model_output_invalid", "Structured-output Retry failed internally.", false, errorMetadata(error));
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
        throw structuredOutputFailureError(result.failure, operation.operationId);
      case "budget_exhausted":
        await callContext.retry.events.emit(retryBudgetExhaustedEvent(operation, result.exhaustion.budgetId, result.exhaustion.progress.completedAttempts, result.exhaustion.progress.totalRetryDelayMs, result.exhaustion.lastFailure, result.exhaustion.exhaustedAt));
        throw structuredOutputRetryExhaustedError("retry_budget_exhausted", result.exhaustion.operationId, result.exhaustion.progress.completedAttempts, result.exhaustion.progress.totalRetryDelayMs, result.exhaustion.lastFailure);
      case "deadline_exhausted":
        throw operationDeadlineError(operation, result.exhaustion.exhaustedAt, result.exhaustion.totalAttempts, result.exhaustion.totalRetryDelayMs, result.exhaustion.lastFailure);
    }
  }
  private async buildRequest(input: TaskDecisionInputSources<TOutput>, context: ProviderRequestBuildContext): Promise<ProviderRequest> {
    return this.representations.buildRequest(input, context);
  }
  private async sendRequest(request: ProviderRequest, controllerInput: TaskDecisionInputSources<TOutput>, callContext: AgentActivityExecutionContext, nextProviderRequestNumber: () => number, modelInputRecoveryAttempt = 0, delivery?: ModelResponseDelivery, rejectedInput?: {
    readonly digest: string;
    readonly code: "provider_context_window_exceeded";
  }): Promise<{
    readonly response: ProviderResponse;
    readonly actualRequest: ProviderRequest;
    readonly inputDeliveryReceipt: ControllerInputDeliveryReceipt | null;
    readonly openingReceipt: ConversationOpeningReceipt | null;
    readonly contextPlanning: ModelInputPlanning | null;
    readonly workingForms?: readonly import("@agent-anything/model-interaction/input").ModelInputOwnerForm[];
    readonly workingAccounts?: readonly import("@agent-anything/model-interaction/input").ModelInputAccount[];
  }> {
    const { sourceRequest, request: assessedRequest } = await this.representations.prepare(request, controllerInput, callContext, modelInputRecoveryAttempt, async (value, context) => {
      const result = await this.executeProviderRequest(value, controllerInput, context, nextProviderRequestNumber());
      if (result.kind !== "response")
        throw new TypeError("Auxiliary preparation cannot continue a Provider session.");
      return result.response;
    }, rejectedInput);
    request = assessedRequest;
    if (request.composition.workingView.recipientRunId !== null &&
      request.composition.workingView.recipientRunId !== controllerInput.runId) {
      throw new TypeError("Prepared request working-view recipient does not match the executing Run.");
    }
    const preparation = await this.continuation.prepare({
      capability: this.input.provider.descriptor.capabilities.continuation,
      lineage: continuationLineage(request, controllerInput),
    });
    const preparedRequest = withContinuation(request, preparation.continuation);
    const inputDeliveryReceipt = createProviderInputDeliveryReceipt(controllerInput.inputDelivery, preparedRequest);
    const openingReceipt = controllerInput.interaction.opening ? null : createConversationOpeningReceipt(controllerInput.runId, preparedRequest);
    let settlement: ProviderRequestSettlement;
    try {
      settlement = await this.executeProviderRequest(preparedRequest, controllerInput, callContext, nextProviderRequestNumber(), delivery);
    }
    catch (error) {
      await this.recordContinuationInterruption(preparation, callContext, error);
      if (this.input.contextPreparation && modelInputRecoveryAttempt === 0 && error instanceof TaskDecisionActivityError &&
        error.failure.kind === "provider" && error.failure.failure.code === "provider_context_window_exceeded") {
        const accepted = await this.acceptContinuation(preparedRequest, controllerInput, callContext, 1, 1, { kind: "capacity_rejection", location: "provider", code: error.failure.failure.code }, null);
        const rejected = {
          digest: modelInputValueDigest({ instructions: request.instructions, messages: request.messages, interaction: request.interaction }),
          code: "provider_context_window_exceeded" as const
        };
        const recovered = snapshotProviderRequest(await new ModelActivityCheckpoint(callContext.checkpoints)
          .once(`context-rejection:${request.requestId}`, () => {
            const id = `${sourceRequest.requestId}:context-rejection:${rejected.digest}`;
            return { ...sourceRequest, requestId: id, composition: { ...sourceRequest.composition, id }, modelContext: { ...sourceRequest.modelContext, assessment: null } };
          }));
        recordContinuedModelInput(accepted, recovered, callContext.executionFlow);
        return this.sendRequest(recovered, controllerInput, callContext, nextProviderRequestNumber, 1, delivery, rejected);
      }
      const recovered = await this.recoverAfterProviderContextRejection(request, error, callContext, modelInputRecoveryAttempt);
      if (recovered !== null) {
        return this.sendRequest(recovered, controllerInput, callContext, nextProviderRequestNumber, modelInputRecoveryAttempt + 1, delivery);
      }
      throw error;
    }
    if (settlement.kind === "continuation_rejected") {
      if (preparation.continuation === null ||
        settlement.continuationId !== preparation.continuation.id) {
        await this.continuation.failed(preparation, "continuation_rejection_uncorrelated", "Provider continuation rejection did not match the request.");
        throw createControllerError("provider", "provider_request_failed", "Provider returned an uncorrelated continuation rejection.", false, { providerId: this.input.provider.descriptor.id }, "settled_failure");
      }
      const resetOutcome = await this.continuation.rejectAndReset(preparation, settlement.providerCode);
      if (resetOutcome.kind === "failed") {
        throw createControllerError("provider", "provider_request_failed", "Provider continuation could not be reset safely.", false, { providerId: this.input.provider.descriptor.id }, "settled_failure");
      }
      const resetPreparation: ModelContinuationPreparation = Object.freeze({
        lineage: preparation.lineage,
        continuation: null,
        outcome: resetOutcome,
      });
      try {
        settlement = await this.executeProviderRequest(withContinuation(request, null), controllerInput, callContext, nextProviderRequestNumber(), delivery);
      }
      catch (error) {
        await this.recordContinuationInterruption(resetPreparation, callContext, error);
        throw error;
      }
      if (settlement.kind === "continuation_rejected") {
        await this.continuation.failed(resetPreparation, "continuation_reset_rejected", "Provider rejected the reconstructed request after continuation reset.");
        throw createControllerError("provider", "provider_request_failed", "Provider rejected the reconstructed request.", false, { providerId: this.input.provider.descriptor.id }, "settled_failure");
      }
      await this.advanceContinuation(resetPreparation, settlement.response);
      return Object.freeze({
        response: settlement.response, actualRequest: withContinuation(request, null), inputDeliveryReceipt, openingReceipt, contextPlanning: request.modelContext.assessment?.planning ?? null,
        ...(this.input.contextPreparation ? { workingForms: request.composition.workingView.forms ?? [], workingAccounts: request.composition.workingView.accounts ?? [] } : {})
      });
    }
    await this.advanceContinuation(preparation, settlement.response);
    return Object.freeze({
      response: settlement.response, actualRequest: preparedRequest, inputDeliveryReceipt, openingReceipt, contextPlanning: request.modelContext.assessment?.planning ?? null,
      ...(this.input.contextPreparation ? { workingForms: request.composition.workingView.forms ?? [], workingAccounts: request.composition.workingView.accounts ?? [] } : {})
    });
  }
  private async recoverAfterProviderContextRejection(request: ProviderRequest, error: unknown, callContext: AgentActivityExecutionContext, recoveryAttempt: number): Promise<ProviderRequest | null> {
    return this.representations.recoverAfterProviderContextRejection(request, error, callContext, recoveryAttempt);
  }
  private async executeProviderRequest(request: ProviderRequest, controllerInput: TaskDecisionInputSources<TOutput>, callContext: AgentActivityExecutionContext, providerRequestNumber: number, delivery?: ModelResponseDelivery): Promise<ProviderRequestSettlement> {
    if (this.input.contextPreparation && !request.composition.lineage.auxiliary) {
      await freezePreparedProviderRequest(request, callContext, JSON.stringify([request.requestId, request.continuation]));
    }
    const auxiliary = request.composition.lineage.auxiliary;
    const activity = createModelActivityBinding({
      runId: controllerInput.runId,
      activityId: callContext.auxiliaryInvocationId ?? (auxiliary ? auxiliary.basis.id : controllerInput.toolExposure.controllerRequestId),
      purpose: request.purpose, owner: auxiliary ? { kind: auxiliary.purpose, inputOwner: "activity" }
        : { kind: "task_decision", inputOwner: "context_representation" }
    });
    return this.modelAccess.execute(request, callContext, providerRequestNumber, activity, delivery);
  }
  private async advanceContinuation(preparation: ModelContinuationPreparation, response: ProviderResponse): Promise<void> {
    const capability = this.input.provider.descriptor.capabilities.continuation;
    if (!capability.supported) {
      if (response.continuation !== null) {
        await this.continuation.failed(preparation, "continuation_capability_mismatch", "Provider returned continuation state while declaring it unsupported.");
      }
      return;
    }
    if (response.kind === "native_tool_turn" && response.turn.finish.kind === "output_limit") {
      await this.continuation.failed(preparation, "model_output_truncated", "Truncated output cannot advance model continuation.");
      return;
    }
    const responseId = response.kind === "native_tool_turn"
      ? response.turn.responseRef.responseId
      : response.responseId;
    if (responseId === null || response.continuation === null) {
      await this.continuation.failed(preparation, "continuation_result_missing", "Continuation-capable Provider returned no correlated continuation state.");
      return;
    }
    await this.continuation.advance({
      preparation,
      mechanism: capability.mechanism,
      responseId,
      state: response.continuation,
    });
  }
  private async recordContinuationInterruption(preparation: ModelContinuationPreparation, callContext: AgentActivityExecutionContext, error: unknown): Promise<void> {
    if (callContext.cancellation.signal.aborted ||
      matchesActiveCancellationError(error, callContext)) {
      await this.continuation.cancelled(preparation);
      return;
    }
    await this.continuation.failed(preparation, "continuation_transport_failed", "Provider transport failed before continuation could advance.");
  }
  private requireStructuredOutputProtocol(): Extract<ModelTaskDecisionCoordinatorOptions<TOutput>["responseProtocol"], {
    readonly kind: "structured_output";
  }> {
    if (this.input.responseProtocol.kind !== "structured_output") {
      throw new TypeError("Structured-output processing requires its explicit response protocol.");
    }
    return this.input.responseProtocol;
  }
  private async parseResponse(response: ProviderResponse, input: TaskDecisionInputSources<TOutput>, request: ProviderRequest, callContext: AgentActivityExecutionContext, executionFlow?: ExecutionFlowContext): Promise<TaskDecisionProposal<TOutput>> {
    try {
      const activity = createModelActivityBinding({
        runId: input.runId, activityId: input.toolExposure.controllerRequestId,
        purpose: request.purpose, owner: { kind: "task_decision", inputOwner: "context_representation" }
      });
      return await this.taskDecisionMaker.decide({ kind: "model_response", source: input, activity, request, response }, { signal: callContext.cancellation.signal, executionFlow });
    }
    catch (error) {
      if (error instanceof TaskDecisionActivityError || error instanceof StructuredOutputError) {
        throw error;
      }
      throw invalidOutput("Provider output parsing failed.", errorMetadata(error));
    }
  }
  private async acceptContinuation(request: Pick<ProviderRequest, "requestId" | "purpose">, input: TaskDecisionInputSources<TOutput>, context: AgentActivityExecutionContext, sequence: number, maximumContinuations: number, cause: ActivityContinuationCause, sourceResponseId: string | null): Promise<AcceptedActivityContinuationRef> {
    const activity = createModelActivityBinding({
      runId: input.runId, activityId: input.toolExposure.controllerRequestId,
      purpose: request.purpose, owner: { kind: "task_decision", inputOwner: "context_representation" }
    });
    const arrangement = createActivityContinuationArrangement({ activity, sourceRequestId: request.requestId, sourceResponseId, sequence, cause });
    const flow = new ExecutionFlowPath(ACTIVITY_CONTINUATION_FLOW, context.executionFlow ?? {}, input.runId, [{ owner: "model-interaction", kind: "request", id: request.requestId, revision: null }]);
    const step = flow.advance("basis", { activityId: activity.id, inputOwner: activity.owner.inputOwner, sequence, maximumContinuations });
    try {
      const accepted = await new ActivityContinuationCoordinator(context.checkpoints).accept({
        arrangement, expectedActivity: activity,
        maximumContinuations, signal: context.cancellation.signal,
        assertAvailable: () => { context.auxiliaryUsage?.assertAvailable(); }
      });
      step.check("activity_and_allowance", "passed");
      flow.advance("accepted", { continuationId: accepted.id, cause: cause.kind })
        .output(flow.material("Accepted activity continuation", "accepted", accepted, "execution", { owner: "agent-runtime", kind: "contribution", id: accepted.id, revision: "1" }));
      flow.close("returned");
      return { id: accepted.id, runId: input.runId, sourceRequestId: request.requestId };
    }
    catch (error) {
      flow.close(context.cancellation.signal.aborted ? "cancelled" : "failed");
      throw error;
    }
  }
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
function structuredOutputInterruption(attempt: RetryAttemptContext, context: AgentActivityExecutionContext, clock: RetryClock) {
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
  return terminalStructuredOutputFailure(invalidOutput("Structured-output attempt was interrupted without trusted attribution."));
}
function terminalStructuredOutputFailure(error: unknown) {
  return {
    kind: "failed" as const,
    error: Object.freeze({ kind: "terminal" as const, error }),
  };
}
function classifyStructuredOutputAttemptFailure(error: StructuredOutputAttemptFailure): RetryClassification<StructuredOutputRetryCategory> {
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
    const code = error.error instanceof TaskDecisionActivityError
      ? error.error.failure.failure.code
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
function createStructuredOutputRetryOperation<TOutput>(input: TaskDecisionInputSources<TOutput>, contractId: string, deadlineAt: string, clock: RetryClock): RetryOperation {
  const controllerRequestId = input.toolExposure.controllerRequestId;
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
function controllerCancellationAttribution(context: AgentActivityExecutionContext, clock: RetryClock) {
  const request = context.cancellation.request;
  if (!context.cancellation.signal.aborted || request === null) {
    throw new TypeError("Controller cancellation requires the active Run request.");
  }
  return Object.freeze({
    requestId: request.id,
    runId: request.runId,
    operation: "controller" as const,
    observedAt: retryNow(clock),
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
function matchesActiveCancellationError(error: unknown, context: AgentActivityExecutionContext): boolean {
  const request = context.cancellation.request;
  return context.cancellation.signal.aborted &&
    request !== null &&
    (error === request || error === context.cancellation.signal.reason);
}
function structuredOutputFailureError(failure: RetryFailure, operationId: string): TaskDecisionActivityError {
  return createControllerError("model", "model_output_invalid", "Model output did not satisfy the active structured-output contract.", false, {
    retryOperationId: operationId,
    structuredOutputFailureCategory: failure.category,
    structuredOutputFailureCode: failure.code,
  }, "settled_failure");
}
function structuredOutputRetryExhaustedError(reason: "retry_budget_exhausted", operationId: string, totalAttempts: number, totalRetryDelayMs: number, lastFailure: RetryFailure | null): TaskDecisionActivityError {
  return createControllerError("model", "model_structured_output_retry_exhausted", "Structured-output correction Retry was exhausted.", false, {
    retryOperationId: operationId,
    retryExhaustionReason: reason,
    retryTotalAttempts: totalAttempts,
    retryTotalDelayMs: totalRetryDelayMs,
    structuredOutputFailureCategory: lastFailure?.category ?? null,
    structuredOutputFailureCode: lastFailure?.code ?? null,
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
function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : fallback;
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
function withContinuation(request: ProviderRequest, continuation: ProviderRequest["continuation"]): ProviderRequest {
  return snapshotProviderRequest({
    ...request,
    continuation,
  });
}
function continuationLineage<TOutput>(request: ProviderRequest, input: TaskDecisionInputSources<TOutput>): ModelContinuationRequestLineage {
  const lineage = request.composition.lineage;
  if (lineage.toolExposureContent === null ||
    lineage.toolExposureProof === null ||
    lineage.callableDefinitions === null) {
    throw new TypeError("Provider continuation requires exact Tool exposure and callable-definition lineage.");
  }
  return Object.freeze({
    providerId: request.composition.providerId,
    model: request.composition.model,
    branchId: `${input.runId}:main`,
    requestId: request.composition.id,
    activeContext: Object.freeze({
      id: input.context.activeContext.id,
      runId: input.context.activeContext.runId,
      version: input.context.activeContext.version,
    }),
    protocol: continuationRevision(lineage.protocol, "protocol"),
    toolExposureContent: continuationRevision(lineage.toolExposureContent, "toolExposureContent"),
    callableDefinitions: continuationRevision(lineage.callableDefinitions, "callableDefinitions"),
    policy: continuationRevision(lineage.policy, "policy"),
  });
}
function continuationRevision(input: {
  readonly id: string;
  readonly revision: string | null;
}, path: string) {
  if (input.revision === null) {
    throw new TypeError(`Provider continuation ${path} revision is required.`);
  }
  return Object.freeze({ id: input.id, revision: input.revision });
}
function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}
function assertControllerCheckpointConfirmed(error: unknown): void {
  if (error instanceof ActivityCheckpointError || error instanceof RetryCheckpointError)
    throw error;
}
type StructuredRetry<T> = RetryCheckpoint<TaskDecisionProposal<T>, StructuredOutputAttemptFailure, string>;
function withInputUsageObservation<T>(decision: TaskDecisionProposal<T>, planning: ModelInputPlanning | null, workingForms?: readonly import("@agent-anything/model-interaction/input").ModelInputOwnerForm[], workingAccounts?: readonly import("@agent-anything/model-interaction/input").ModelInputAccount[]): TaskDecisionProposal<T> {
  if (!planning && workingForms === undefined && workingAccounts === undefined)
    return decision;
  const complete = decision.modelItems.some(item => item.kind === "model_turn_finish" &&
    item.finish.kind === "normal");
  return Object.freeze({
    ...decision, modelItems: Object.freeze(decision.modelItems.map(item => {
      if (item.kind !== "model_response_correlation" || planning && item.response.requestId !== planning.requestId)
        return item;
      const observation = planning ? observeModelInputUsage(planning, item.usage, item.response.responseId, complete) : null;
      return Object.freeze({
        ...item, metadata: Object.freeze({
          ...item.metadata, ...(planning ? { inputPlanningId: planning.id } : {}),
          ...(workingForms === undefined ? {} : { workingForms }),
          ...(workingAccounts === undefined ? {} : { workingAccounts }),
          ...(observation ? { inputUsageObservation: observation } : { inputUsageExclusion: "incomplete_or_unqualified_usage" })
        })
      });
    }))
  });
}
function encodeStructuredRetry<T>(checkpoint: StructuredRetry<T>): unknown {
  const encode = (value: StructuredOutputAttemptFailure) => value.kind !== "terminal" ? value : {
    kind: "terminal", error: value.error instanceof TaskDecisionActivityError
      ? { kind: "controller", failure: value.error.failure, settlement: value.error.operationSettlement, deadline: value.error.deadline }
      : { kind: "error", message: messageFrom(value.error, "Structured output failed.") },
  };
  return {
    ...checkpoint,
    attemptResult: checkpoint.attemptResult?.kind === "failed" ? { ...checkpoint.attemptResult, error: encode(checkpoint.attemptResult.error) } : checkpoint.attemptResult,
    outcome: checkpoint.outcome?.kind === "failed" ? { ...checkpoint.outcome, error: encode(checkpoint.outcome.error) } : checkpoint.outcome,
  };
}
function decodeStructuredRetry<T>(record: unknown): StructuredRetry<T> | null {
  if (record === null)
    return null;
  if (!isRecord(record))
    throw new ActivityCheckpointError("structured_retry_invalid");
  const checkpoint = record as unknown as StructuredRetry<T>;
  const decode = (value: StructuredOutputAttemptFailure): StructuredOutputAttemptFailure => {
    if (value.kind !== "terminal")
      return value;
    const error = value.error;
    if (!isRecord(error))
      throw new ActivityCheckpointError("structured_retry_error_invalid");
    if (error.kind === "controller")
      return {
        kind: "terminal", error: new TaskDecisionActivityError(error.failure as TaskDecisionActivityFailure, error.settlement as TaskDecisionActivityError["operationSettlement"], error.deadline as TaskDecisionActivityError["deadline"])
      };
    if (error.kind === "error" && typeof error.message === "string")
      return { kind: "terminal", error: new Error(error.message) };
    throw new ActivityCheckpointError("structured_retry_error_invalid");
  };
  return {
    ...checkpoint,
    attemptResult: checkpoint.attemptResult?.kind === "failed" ? { ...checkpoint.attemptResult, error: decode(checkpoint.attemptResult.error) } : checkpoint.attemptResult,
    outcome: checkpoint.outcome?.kind === "failed" ? { ...checkpoint.outcome, error: decode(checkpoint.outcome.error) } : checkpoint.outcome,
  };
}
