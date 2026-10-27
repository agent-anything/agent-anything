import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { Provider, ProviderRequest, ProviderResponse } from "@agent-anything/model-interaction";
import { assessModelContext, createProviderSemanticRequestDigest, snapshotProviderFailure, snapshotProviderRequest, type ModelContextAssessment } from "@agent-anything/model-interaction";
import { planModelInput, type ModelInputUsageObservation } from "@agent-anything/model-interaction/context";
import { snapshotModelInputComposition, type ModelInputComposition } from "@agent-anything/model-interaction/input";
import { ExecutionFlowPath } from "@agent-anything/observability/execution-flow";
import type { AgentActivityExecutionContext, TaskDecisionInputSources } from "../decision/TaskDecisionActivity.js";
import { prepareContextRepresentation, type ContextRepresentationPreparationSupport } from "./ContextRepresentationPreparation.js";
import { contextSemanticTargetDigest } from "./ContextSemanticPreparation.js";
import { freezeConversationOpening } from "../decision/TaskConversation.js";
import { TaskDecisionActivityError, type TaskDecisionActivityFailure, type TaskDecisionActivityFailureCode, type DecisionActivityDeadline } from "../decision/TaskDecisionActivityError.js";
import { MODEL_CONTEXT_EXECUTION_FLOW } from "./ModelContextExecutionFlow.js";
import type { ModelInputRecoveryPort } from "./ModelInputRecovery.js";
import { unsupportedModelInputRecovery } from "./ModelInputRecovery.js";
import { resumeContextBackground } from "./ContextBackgroundPreparation.js";
import { createModelOutputRecoverySection } from "../decision/ModelOutputRecovery.js";
import { ModelActivityCheckpoint } from "../model-access/ModelActivityCheckpoint.js";
import { recordContinuedModelInput } from "../model-access/ModelInputContinuation.js";
import { ActivityCheckpointError } from "../activity/ActivityCheckpoint.js";
import { type ProviderRequestBuildContext } from "../decision/StructuredOutput.js";
import type { RetryClock } from "../retry/index.js";
export interface ContextRepresentationManagerOptions<TOutput = unknown> {
  readonly provider: Pick<Provider, "descriptor" | "modelContext">;
  readonly buildRequest: BuildProviderRequest<TOutput>;
  readonly retryClock: RetryClock;
  readonly modelInputRecovery?: ModelInputRecoveryPort;
  readonly contextPreparation?: ContextRepresentationPreparationSupport;
}
export class ContextRepresentationManager<TOutput = unknown> {
  private readonly modelInputRecovery: ModelInputRecoveryPort;
  constructor(private readonly input: ContextRepresentationManagerOptions<TOutput>) {
    this.modelInputRecovery = input.modelInputRecovery ?? unsupportedModelInputRecovery;
  }
  async resumeBackground(runId: string, context: AgentActivityExecutionContext, send: (request: ProviderRequest, context: AgentActivityExecutionContext) => Promise<ProviderResponse>): Promise<void> {
    const support = this.input.contextPreparation;
    if (!support?.semantic?.background?.enabled)
      return;
    await resumeContextBackground({
      store: support.store, support: support.semantic, runId, context,
      targetDigest: contextSemanticTargetDigest(this.input.provider), send,
      measure: (request, activity) => this.prepareModelContextRequest(request, activity, 0, runId, null, true)
    });
  }
  async prepare(request: ProviderRequest, controllerInput: TaskDecisionInputSources<TOutput>, callContext: AgentActivityExecutionContext, modelInputRecoveryAttempt: number, sendAuxiliary: (request: ProviderRequest, context: AgentActivityExecutionContext) => Promise<ProviderResponse>, rejectedInput?: {
    readonly digest: string;
    readonly code: "provider_context_window_exceeded";
  }): Promise<{
    readonly sourceRequest: ProviderRequest;
    readonly request: ProviderRequest;
  }> {
    if (!controllerInput.interaction.opening)
      request = await freezeConversationOpening(request, controllerInput.runId, callContext.runCheckpoints);
    const sourceRequest = request;
    const previousUsage = controllerInput.interaction.inputUsageObservations?.find(value => value.purpose === request.purpose) ?? null;
    const scopedContext = (signal?: AbortSignal): AgentActivityExecutionContext => signal ? {
      ...callContext, cancellation: {
        runId: callContext.cancellation.runId, signal, get request() { return callContext.cancellation.request; }
      }
    } : callContext;
    const auxiliary = async (value: ProviderRequest, context: AgentActivityExecutionContext) => {
      if (!value.composition.lineage.auxiliary || value.interaction.kind !== "structured_generation" || value.continuation) {
        throw new TypeError("Auxiliary preparation requires a stateless typed data request.");
      }
      if (value.modelContext.assessment?.disposition === "proven_overflow")
        throw new TypeError("Auxiliary input exceeds its proven capacity.");
      const result = await sendAuxiliary(value, context);
      if (result.kind !== "structured_generation")
        throw new TypeError("Auxiliary response is not complete structured data.");
      return result;
    };
    const assessedRequest = this.input.contextPreparation ? await prepareContextRepresentation({
      support: this.input.contextPreparation,
      request: sourceRequest, controller: controllerInput, context: callContext, now: () => this.input.retryClock.now().getTime(),
      ...(rejectedInput ? { rejectedInput } : {}),
      measure: (value, signal) => this.prepareModelContextRequest(value, scopedContext(signal), modelInputRecoveryAttempt, controllerInput.runId, previousUsage, true),
      admit: (value, signal) => this.prepareModelContextRequest(value, scopedContext(signal), modelInputRecoveryAttempt, controllerInput.runId, previousUsage),
      ...(this.input.contextPreparation.semantic && this.input.provider.descriptor.capabilities.structuredGeneration.supported ? {
        semanticTarget: contextSemanticTargetDigest(this.input.provider),
        auxiliary: (value: ProviderRequest, signal?: AbortSignal) => auxiliary(value, scopedContext(signal)),
        background: {
          send: auxiliary, measure: (value: ProviderRequest, context: AgentActivityExecutionContext) => this.prepareModelContextRequest(value, context, 0, controllerInput.runId, null, true)
        },
      } : {}),
    }) : snapshotProviderRequest(await new ModelActivityCheckpoint(callContext.checkpoints)
      .once(`assessed-request:${request.requestId}:${modelInputRecoveryAttempt}`, () => this.prepareModelContextRequest(request, callContext, modelInputRecoveryAttempt, controllerInput.runId, controllerInput.interaction.inputUsageObservations?.find(value => value.purpose === request.purpose) ?? null)));
    return { sourceRequest, request: assessedRequest };
  }
  async buildRequest(input: TaskDecisionInputSources<TOutput>, context: ProviderRequestBuildContext): Promise<ProviderRequest> {
    try {
      const request = snapshotProviderRequest(await this.input.buildRequest(input, context));
      const target = this.input.provider.modelContext.target;
      const requestedOutput = this.input.provider.modelContext.requestedOutput;
      if (request.composition.providerId !== target.providerId ||
        request.composition.model !== target.model ||
        request.modelContext.requestedOutput.unit !== requestedOutput.unit ||
        request.modelContext.requestedOutput.maximum !== requestedOutput.maximum ||
        request.modelContext.requestedOutput.source !== requestedOutput.source ||
        request.modelContext.requestedOutput.revision !== requestedOutput.revision ||
        request.modelContext.assessment !== null) {
        throw new TypeError("Provider request does not match its admitted model target and output request.");
      }
      const recovery = createModelOutputRecoverySection(context.outputRecovery);
      if (recovery !== null && (request.requestId === context.outputRecovery!.sourceRequestId ||
        request.composition.sections.filter(section => section.kind === "model_output_recovery").length !== 1 ||
        !request.composition.sections.some(section => JSON.stringify(section) === JSON.stringify(recovery)))) {
        throw new TypeError("Output recovery requires a new request containing the exact attributed recovery section.");
      }
      return request;
    }
    catch (error) {
      throw createControllerError("model", "model_request_failed", messageFrom(error, "Model request construction failed."), false, errorMetadata(error));
    }
  }
  async prepareModelContextRequest(request: ProviderRequest, callContext: AgentActivityExecutionContext, recoveryAttempt: number, runId: string, previous: ModelInputUsageObservation | null = null, measureOnly = false): Promise<ProviderRequest> {
    const flow = new ExecutionFlowPath(MODEL_CONTEXT_EXECUTION_FLOW, callContext.executionFlow ?? {}, runId, [{ owner: "model-interaction", kind: "request", id: request.requestId, revision: null }]);
    try {
      const result = await this.assessModelContextRequest(request, callContext, recoveryAttempt, flow, previous, measureOnly);
      flow.current?.output(flow.material(measureOnly ? "Measured model context" : "Admitted model context", measureOnly ? "measured" : "admitted", { requestId: result.requestId, compositionId: result.composition.id, modelContext: result.modelContext }, "provider"));
      flow.close("returned");
      return result;
    }
    catch (error) {
      flow.close(callContext.cancellation.signal.aborted ? "cancelled" : "failed");
      throw error;
    }
  }
  async assessModelContextRequest(request: ProviderRequest, callContext: AgentActivityExecutionContext, recoveryAttempt: number, flow: ExecutionFlowPath, previous: ModelInputUsageObservation | null, measureOnly = false): Promise<ProviderRequest> {
    const measurementStep = flow.advance("measure", { recoveryAttempt }, [flow.material("Model context admission input", "received", {
      requestId: request.requestId, compositionId: request.composition.id,
      capacity: this.input.provider.modelContext.capacity, requestedOutput: request.modelContext.requestedOutput, headroom: request.modelContext.headroom
    }, "provider")]);
    const measuredAt = this.input.retryClock.now().toISOString();
    const modelContext = this.input.provider.modelContext;
    const priorAssessment = request.modelContext.assessment;
    const nativeMeasurement = priorAssessment?.measurement ?? await measureWithCancellation(modelContext, request.composition, measuredAt, callContext.cancellation.signal);
    const accounting = modelContext.accounting;
    const planning = priorAssessment?.planning ?? (accounting ? planModelInput({
      requestId: request.requestId, runId: flow.runId, purpose: request.purpose,
      accounting, footprint: accounting.project(request.composition), measurement: nativeMeasurement, capacity: modelContext.capacity,
      sections: request.composition.sections, requestedOutput: request.modelContext.requestedOutput,
      previous, growthPolicy: `working-view:${request.composition.workingView.version}:owner-forms`
    }) : null);
    const measurement = planning?.measurement ?? nativeMeasurement;
    const assessment = assessModelContext({
      compositionId: request.composition.id,
      ...(planning ? { planning } : {}),
      capacity: modelContext.capacity,
      measurement,
      requestedOutput: request.modelContext.requestedOutput,
      headroom: request.modelContext.headroom,
      assessedAt: measuredAt,
      revision: "agent-runtime.model-context-assessment.v1",
    });
    const assessedRequest = withModelContextAssessment(request, assessment);
    const assessmentRef = flow.material("Model context measurement and assessment", "assessed", { measurement, assessment }, "provider");
    measurementStep.output(assessmentRef);
    if (planning?.allocation) {
      const allocation = planning.allocation;
      measurementStep.output(flow.material("Model input allocation", "assessed", {
        requestId: request.requestId, planningId: planning.id, unit: measurement.status === "measured" ? measurement.estimator.unit : measurement.unit,
        measurementStatus: measurement.status, groupAttribution: planning.groupAttribution,
        estimator: measurement.estimator, uncertainty: measurement.status === "measured" ? measurement.uncertainty : null,
        target: allocation.target, baseline: allocation.baseline, used: allocation.used,
        groups: allocation.groups.map(({grant, ...group}) => ({...group, allocatedAmount: grant})),
        selected: allocation.selected, limitations: [...new Set([...planning.limitations, ...allocation.limitations])],
      }, "provider"));
    }
    measurementStep.check("capacity", assessment.disposition === "unresolved" ? "not_evaluated" : assessment.disposition.endsWith("overflow") ? "not_satisfied" : "passed", { assessmentId: assessment.id, disposition: assessment.disposition, effectiveInputBudget: assessment.effectiveInputBudget });
    if (measureOnly || assessment.disposition !== "proven_overflow" &&
      assessment.disposition !== "estimated_overflow") {
      flow.advance("result", { disposition: assessment.disposition }, [assessmentRef]).check("proven_overflow", measureOnly ? "not_evaluated" : "passed");
      return assessedRequest;
    }
    const capability = this.modelInputRecovery.capability;
    const shouldRecover = assessment.disposition === "proven_overflow" || capability.supported;
    const recoveryStep = flow.advance("recovery", { recoveryAttempt }, [assessmentRef]);
    recoveryStep.check("recovery_capability", shouldRecover && capability.supported && recoveryAttempt < capability.maximumAttempts ? "passed" : "not_applicable", { supported: capability.supported, maximumAttempts: capability.supported ? capability.maximumAttempts : 0 });
    if (shouldRecover && capability.supported && recoveryAttempt < capability.maximumAttempts) {
      const recovered = await this.recoverModelInput(assessedRequest, assessment, callContext, recoveryAttempt + 1, Object.freeze({ kind: "local_assessment" as const }));
      recoveryStep.check("recovery_result", recovered === null ? "not_satisfied" : "passed");
      if (recovered !== null) {
        const result = await this.prepareModelContextRequest(recovered, { ...callContext, executionFlow: flow.callContext }, recoveryAttempt + 1, flow.runId, previous);
        flow.advance("result", { disposition: result.modelContext.assessment?.disposition ?? null })
          .check("proven_overflow", "not_evaluated", { reason: "checked_by_recovered_request_admission" });
        return result;
      }
    }
    else {
      recoveryStep.check("recovery_result", "not_evaluated", { reason: "recovery_not_admitted" });
    }
    flow.advance("result", { disposition: assessment.disposition }, [assessmentRef]).check("proven_overflow", assessment.disposition === "proven_overflow" ? "not_satisfied" : "passed");
    if (assessment.disposition === "proven_overflow") {
      throw createControllerError("model", "model_context_capacity_exceeded", "The composed model input is proven to exceed the admitted model context capacity.", false, {
        providerId: modelContext.target.providerId,
        model: modelContext.target.model,
        modelContextAssessmentId: assessment.id,
        modelContextDisposition: assessment.disposition,
        effectiveInputBudget: assessment.effectiveInputBudget,
      }, "settled_failure");
    }
    return assessedRequest;
  }
  async recoverAfterProviderContextRejection(request: ProviderRequest, error: unknown, callContext: AgentActivityExecutionContext, recoveryAttempt: number): Promise<ProviderRequest | null> {
    if (!(error instanceof TaskDecisionActivityError) ||
      error.failure.kind !== "provider" ||
      error.failure.failure.code !== "provider_context_window_exceeded" ||
      request.modelContext.assessment === null) {
      return null;
    }
    const capability = this.modelInputRecovery.capability;
    if (!capability.supported || recoveryAttempt >= capability.maximumAttempts)
      return null;
    return this.recoverModelInput(request, request.modelContext.assessment, callContext, recoveryAttempt + 1, Object.freeze({
      kind: "provider_rejection" as const,
      failure: error.failure.failure,
    }));
  }
  async recoverModelInput(request: ProviderRequest, assessment: ModelContextAssessment, callContext: AgentActivityExecutionContext, attemptNumber: number, trigger: Parameters<ModelInputRecoveryPort["recover"]>[0]["trigger"]): Promise<ProviderRequest | null> {
    const capability = this.modelInputRecovery.capability;
    if (request.composition.lineage.auxiliary || !capability.supported || !callContext.acceptInputRepreparation) {
      throw new ActivityCheckpointError("input_repreparation_coordination_unavailable");
    }
    const accepted = await callContext.acceptInputRepreparation({
      requestId: request.requestId, purpose: request.purpose,
      sequence: attemptNumber, maximum: capability.maximumAttempts,
      location: trigger.kind === "provider_rejection" ? "provider" : "local_admission"
    });
    const sourceDigest = createProviderSemanticRequestDigest(request);
    const outcome = await new ModelActivityCheckpoint(callContext.checkpoints).once(`input-repreparation:${request.requestId}:${attemptNumber}`, () => this.modelInputRecovery.recover(Object.freeze({
      sourceRequest: request,
      sourceComposition: request.composition,
      targetCapacity: this.input.provider.modelContext.capacity,
      assessment,
      requestDigest: sourceDigest,
      attempt: Object.freeze({
        id: `${request.requestId}:model-input-recovery:${attemptNumber}`,
        number: attemptNumber,
      }),
      trigger,
    }), interruptionContext(callContext)));
    if (outcome.status === "unavailable")
      return null;
    if (outcome.status === "failed") {
      throw createControllerError("model", "model_input_recovery_failed", outcome.failure.message, outcome.failure.retryable, {
        ...outcome.failure.metadata,
        contextPath: outcome.failure.path,
        modelContextAssessmentId: assessment.id,
      }, "settled_failure");
    }
    const composition = snapshotModelInputComposition(outcome.composition);
    if (outcome.predecessorCompositionId !== request.composition.id ||
      composition.id === request.composition.id) {
      throw createControllerError("model", "model_input_recovery_failed", "Model input recovery returned an invalid composition lineage.", false, { modelContextAssessmentId: assessment.id }, "settled_failure");
    }
    const recovered = withRecoveredComposition(request, composition);
    if (createProviderSemanticRequestDigest(recovered) === sourceDigest) {
      throw createControllerError("model", "model_input_recovery_failed", "Model input recovery returned an unchanged semantic request.", false, { modelContextAssessmentId: assessment.id }, "settled_failure");
    }
    recordContinuedModelInput(accepted, recovered, callContext.executionFlow);
    return recovered;
  }
}
export type BuildProviderRequest<TOutput = unknown> = (input: TaskDecisionInputSources<TOutput>, context: ProviderRequestBuildContext) => ProviderRequest | Promise<ProviderRequest>;
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
function withModelContextAssessment(request: ProviderRequest, assessment: ModelContextAssessment): ProviderRequest {
  return snapshotProviderRequest({
    ...request,
    modelContext: Object.freeze({
      ...request.modelContext,
      assessment,
    }),
  });
}
function withRecoveredComposition(request: ProviderRequest, composition: ModelInputComposition): ProviderRequest {
  return snapshotProviderRequest({
    ...request,
    requestId: composition.id,
    instructions: composition.instructions,
    messages: composition.messages,
    interaction: composition.interaction,
    composition,
    modelContext: Object.freeze({
      ...request.modelContext,
      assessment: null,
    }),
  });
}
function interruptionContext(callContext: AgentActivityExecutionContext): InvocationInterruptionContext {
  return Object.freeze({
    signal: callContext.cancellation.signal,
    interruption: callContext.cancellation.request === null
      ? null
      : Object.freeze({
        kind: "run_cancellation" as const,
        cancellation: Object.freeze({
          runId: callContext.cancellation.request.runId,
          requestId: callContext.cancellation.request.id,
        }),
      }),
  });
}
async function measureWithCancellation(context: import("@agent-anything/model-interaction").ProviderModelContext, composition: import("@agent-anything/model-interaction/input").ModelInputComposition, measuredAt: string, signal: AbortSignal): Promise<import("@agent-anything/model-interaction").ModelInputMeasurement> {
  signal.throwIfAborted();
  let remove = () => { };
  const cancelled = new Promise<never>((_, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    remove = () => signal.removeEventListener("abort", abort);
  });
  try {
    const result = await Promise.race([context.measureAsync ? context.measureAsync(composition, measuredAt, signal)
      : Promise.resolve(context.measure(composition, measuredAt)), cancelled]);
    signal.throwIfAborted();
    return result;
  }
  finally {
    remove();
  }
}
