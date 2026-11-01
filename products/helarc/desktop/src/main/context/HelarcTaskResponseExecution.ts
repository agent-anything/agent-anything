import {TaskModelResponseActivity, TaskModelResponseWork, retainTaskDecisionSource,
  type AgentActivityExecutionContext, type TaskDecisionInputSources, type TaskModelResponseActivityPorts,
  type TaskModelResponseSubmission} from "@agent-anything/agent-runtime/decision";
import type {ActivityPurposeHandler, ActivityPurposeRegistry} from "@agent-anything/agent-runtime/activity";
import type {PreparedContextInput} from "@agent-anything/agent-runtime/context-representation";
import type {ContextSelectionPort} from "@agent-anything/context/selection";
import type {Provider} from "@agent-anything/model-interaction";
import type {HelarcTaskModelBinding, HelarcTaskExecutionComposition} from "@agent-anything/helarc/composition";
import type {HelarcAgentOutput} from "@agent-anything/helarc/controller";
import {ModelResponseDelivery} from "@agent-anything/agent-runtime/model-access";

export interface HelarcTaskResponseExecutionInput {
  readonly provider: Provider;
  readonly purposes: ActivityPurposeRegistry<ActivityPurposeHandler>;
  readonly activities: TaskModelResponseActivityPorts<HelarcAgentOutput>["activities"];
  readonly acceptance: TaskModelResponseActivityPorts<HelarcAgentOutput>["acceptance"];
  readonly selections: ContextSelectionPort;
  readonly authorize: ActivityPurposeHandler["authorize"];
  readonly host: TaskModelResponseActivityPorts<HelarcAgentOutput>["host"];
  readonly preparations: HelarcTaskExecutionComposition["preparations"];
  /** Original bounded delegation data only; dispatch and input preparation belong to shared facilities. */
  readonly arrange: (source: TaskDecisionInputSources<HelarcAgentOutput>, context: AgentActivityExecutionContext) =>
    Pick<TaskModelResponseSubmission, "identity" | "schedule"> | Promise<Pick<TaskModelResponseSubmission, "identity" | "schedule">>;
  readonly rediscoveryMs: number;
  readonly settlementWaitMs: number;
  readonly now: () => string;
}

/** Binds Product rules to original Host facilities; input choice remains with its supplier. */
export function createHelarcTaskResponseExecution(input: HelarcTaskResponseExecutionInput, binding: HelarcTaskModelBinding):
  HelarcTaskExecutionComposition & {readonly work: TaskModelResponseWork<HelarcAgentOutput>} {
  const deliveries=new Map<string,ModelResponseDelivery>();
  const work = new TaskModelResponseWork<HelarcAgentOutput>(input.purposes, {
    provider: input.provider, activities: input.activities, selections: input.selections, now: input.now,
    resolveAgent: binding.resolveAgent, interpret: binding.interpret,
    requestObserved: binding.observeRequest,
    authorize: async (path, stage, signal, action) => {
      if (stage.request.stageKind === "model" && (stage.request.input as PreparedContextInput).encoded.mode !== binding.delivery.mode)
        throw new TypeError("helarc_task_original_delivery_mode_changed");
      return input.authorize(path, stage, signal, action);
    },
    observer:(path,stage,attempt,signal)=>{
      const request=(stage.request.input as PreparedContextInput).request;
      if(!request.correlation?.controllerRequestId)throw new TypeError("task_delivery_identity_unavailable");
      const delivery=new ModelResponseDelivery(path.intent.runId,request.correlation.controllerRequestId,binding.delivery);
      deliveries.set(stage.request.id,delivery);
      return delivery.invocation(attempt.id,request.requestId,signal).observer!;
    },
    interpreted:(_path,stage,proposal)=>{
      const delivery=deliveries.get(stage.request.id);deliveries.delete(stage.request.id);
      delivery?.finish(proposal?"validated":"rejected",proposal?.modelItems??[]);
    },
  });
  const usage = input.provider.descriptor.capabilities.usageMetering;
  const taskDecisions = new TaskModelResponseActivity<HelarcAgentOutput>({
    work, activities: input.activities, acceptance: input.acceptance, host: input.host,
    rediscoveryMs: input.rediscoveryMs, settlementWaitMs: input.settlementWaitMs,
    resourceMetering: {modelInputTokens: usage.inputTokens, modelOutputTokens: usage.outputTokens, costUnits: usage.costUnits},
    prepare: async (source, context) => {
      binding.resolveAgent(source.agent);
      const arrangement = await input.arrange(source, context);
      context.cancellation.signal.throwIfAborted();
      const request = binding.buildRequest(source, {attemptNumber: 1, correction: null, executionFlow: context.executionFlow,
        target: input.provider.modelContext.target, requestedOutput: input.provider.modelContext.requestedOutput});
      return {...arrangement, source: {kind: "task_model_source", record: retainTaskDecisionSource(source), request, protocol: binding.protocol}};
    },
  });
  return {taskDecisions, preparations: input.preparations, work};
}
