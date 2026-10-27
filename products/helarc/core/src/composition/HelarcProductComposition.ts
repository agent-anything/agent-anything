import { ModelTaskDecisionCoordinator } from "@agent-anything/agent-runtime/execution-coordinator";
import { HelarcProtocolRecoveryController } from "../controller/HelarcProtocolRecoveryController.js";
import { createSystemRetryExecutor, systemRetryClock } from "@agent-anything/agent-runtime/retry";
import type { TaskDecisionActivity } from "@agent-anything/agent-runtime/decision";
import type { RunResult } from "@agent-anything/agent-runtime/run";
import type { RunTranscriptRecord } from "@agent-anything/agent-runtime/transcript";
import type { RunLineage } from "@agent-anything/agent-core/run-tree";
import { appendHelarcRunPresentation, associateHelarcOperationPresentation, labelHelarcRunPresentation, receiveHelarcRunInputPresentation } from "../run/presentation/HelarcRunPresentation.js";
import type { RunInput } from "@agent-anything/agent-core/input";
import { HelarcResponsePreviewStore, type HelarcResponsePreview, type HelarcResponsePreviews } from "../run/presentation/HelarcResponsePreviews.js";
import type { RunnerDelegationComposition } from "@agent-anything/agent-runtime/execution-coordinator";
import {
  createDefaultHelarcInstructionSettings,
  snapshotHelarcInstructionSettings,
  type HelarcInstructionSettings,
} from "../instructions/index.js";
import {
  AgentHookExtensions,
  type AgentHookExecutionStore,
  type AgentHookRecordPort,
} from "@agent-anything/agent-hooks/execution";
import type { RuntimeEvent } from "@agent-anything/observability/events";
import { ExecutionFlowPath, type ExecutionFlowContext } from "@agent-anything/observability/execution-flow";
import { HELARC_RESULT_EXECUTION_FLOW } from "./HelarcResultExecutionFlow.js";
import type { AgentDefinition } from "@agent-anything/agent-core/agent";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import type { CodeSourcePort } from "@agent-anything/helarc-code-agent/source";
import type { RetryClock } from "@agent-anything/agent-runtime/retry";
import type {
  SandboxEnforcement,
} from "@agent-anything/action-execution/sandbox";
import {
  buildHelarcProviderRequest,
  parseHelarcProviderResponse,
  type HelarcAgentOutput,
} from "../controller/HelarcController.js";
import {
  createHelarcBaselineControllerProtocolComposition,
  type HelarcControllerProtocolComposition,
} from "../controller/HelarcControllerProtocolComposition.js";
import {
  createHelarcAgent,
  createHelarcDelegatedWorkerAgent,
} from "../agent/HelarcAgent.js";
import type { HelarcMainInstructionTarget } from "../instructions/index.js";
import { createHelarcDescendantAgentContribution } from "../agent/HelarcDescendantAgent.js";
import {validateHelarcFinalMaterials, type HelarcMaterialHandoff} from "../tools/HelarcMaterialHandoff.js";
import {
  HelarcTracingController,
  projectHelarcControllerTraceForEvent,
  type HelarcControllerTraceProjection,
} from "../observability/index.js";
import type { HelarcTaskInput } from "../task/HelarcTaskInput.js";
import type { HelarcProviderProfile } from "../configuration/index.js";
import { assertHelarcProviderCompatibility } from "./HelarcProviderCompatibility.js";
import type { Provider } from "@agent-anything/model-interaction";
import {
  ModelContinuationLifecycle,
  type ModelContinuationSafeEvent,
  type ModelContinuationStore,
} from "@agent-anything/model-interaction/continuation";
import {
  createInteractionProtocolRegistrySnapshot,
  type InteractionProtocolRegistrySnapshot,
} from "@agent-anything/interaction/coordination";
import { createHelarcClarificationContribution } from "../interaction/index.js";
import {
  createHelarcActionComposition,
  type HelarcCommandActionContribution,
  type HelarcFileActionContribution,
} from "./HelarcActionComposition.js";
import {
  projectHelarcProductResult,
  mapRuntimeEventToHelarcActivity,
  type HelarcActivityItem,
  type HelarcProductResult,
} from "./HelarcProductResult.js";
import {
  createHelarcProductRunProjection,
  reduceHelarcProductRunProjection,
  type HelarcProductRunProjection,
  type HelarcProductRunProjectionListener,
  type HelarcProductRunProjectionUpdate,
} from "../run/HelarcRunProjection.js";
import {
  createHelarcTaskFulfillmentHookComposition,
  type HelarcTaskFulfillmentHook,
} from "../task-fulfillment/index.js";

type HelarcProductProjectionUpdatePayload =
  HelarcProductRunProjectionUpdate extends infer TUpdate
    ? TUpdate extends HelarcProductRunProjectionUpdate
      ? Omit<TUpdate, "runId" | "sequence">
      : never
    : never;

export interface CreateHelarcProductCompositionInput {
  readonly contextMaterials?: import("@agent-anything/context/material").ContextMaterialAccessPort;
  readonly contextPreparation?: import("@agent-anything/agent-runtime/context-representation").ContextRepresentationPreparationSupport;
  readonly materialHandoff?: HelarcMaterialHandoff;
  readonly executionEvidenceAccess?: import("@agent-anything/operation-catalog/evidence").ExecutionEvidenceAccessPort;
  readonly executionHandoff?: import("../tools/HelarcExecutionHandoff.js").HelarcExecutionHandoff;
  readonly executionMaterials?: import("../tools/HelarcExecutionDetails.js").HelarcExecutionMaterialReader;
  readonly executionCollections?: import("../tools/HelarcExecutionDetails.js").HelarcExecutionCollectionReader;
  readonly executionEvidence?: import("@agent-anything/operation-catalog/evidence").ExecutionEvidenceRecordPort;
  readonly hookInvocationRecords?: AgentHookRecordPort;
  readonly responseDelivery?: "buffered" | "streaming";
  readonly executionFlow?: ExecutionFlowContext;
  readonly runId: string;
  readonly task: AgentTask<HelarcTaskInput>;
  readonly workspace: WorkspaceSelection;
  readonly provider: Provider;
  readonly providerProfile: HelarcProviderProfile;
  readonly instructionTarget: HelarcMainInstructionTarget;
  readonly instructionSettings?: HelarcInstructionSettings;
  readonly codeSource: CodeSourcePort;
  readonly fileActions: HelarcFileActionContribution;
  readonly commandActions: HelarcCommandActionContribution;
  readonly modelContinuationStore?: ModelContinuationStore;
  readonly now?: () => string;
}

export interface HelarcProductComposition {
  readonly agent: AgentDefinition<HelarcAgentOutput>;
  readonly delegatedAgent: AgentDefinition<HelarcAgentOutput>;
  readonly taskDecisions: TaskDecisionActivity<HelarcAgentOutput>;
  readonly extensions: import("@agent-anything/agent-runtime/execution-coordinator").AgentExecutionExtensions<HelarcAgentOutput>;
  readonly preparations: import("@agent-anything/agent-runtime/context-representation").ContextPreparationLifecycle;
  readonly controllerProtocol: HelarcControllerProtocolComposition;
  readonly actions: Awaited<ReturnType<typeof createHelarcActionComposition>>;
  readonly interactions: InteractionProtocolRegistrySnapshot;
  readonly delegation: RunnerDelegationComposition;
  readonly agentHooks: AgentHookExecutionStore;
  readonly hookRegistrations: readonly import("@agent-anything/agent-hooks/composition").AgentHookRegistration[];
  readonly taskFulfillment: HelarcTaskFulfillmentHook;
  readonly runMetadata: Readonly<Record<string, unknown>>;
  getProductProjection(): HelarcProductRunProjection;
  getResponsePreviews(): HelarcResponsePreviews;
  subscribeResponsePreviews(listener: (value: HelarcResponsePreviews, attempt: HelarcResponsePreview) => void): () => void;
  recordTranscript(record: RunTranscriptRecord): void;
  recordRunLineage(runId: string, lineage: RunLineage): void;
  recordRunInput(runId: string, input: RunInput, receivedAt: string): void;
  recordCommandProgress(command:Omit<import("../run/HelarcRunProjection.js").HelarcCommandProgress, "origin">):void;
  subscribeProductProjection(listener: HelarcProductRunProjectionListener): () => void;
  recordRuntimeEvent(event: RuntimeEvent): {
    readonly event: RuntimeEvent;
    readonly activity: HelarcActivityItem;
  };
  projectResult(
    runResult: RunResult<HelarcAgentOutput>,
    selectedEnforcement: SandboxEnforcement,
  ): HelarcProductResult;
}

export async function createHelarcProductComposition(
  input: CreateHelarcProductCompositionInput,
): Promise<HelarcProductComposition> {
  const instructionSettings = input.instructionSettings === undefined
    ? undefined : snapshotHelarcInstructionSettings(input.instructionSettings);
  const now = input.now ?? (() => new Date().toISOString());
  const admittedAt = now();
  const providerId = input.provider.descriptor.id;
  const modelId = input.provider.modelContext.target.model;
  if (providerId !== input.provider.modelContext.target.providerId) {
    throw new TypeError("Helarc Provider descriptor and Model Input Accounting identities differ.");
  }
  const agent = createHelarcAgent({
    instructionSettings,
    target: input.instructionTarget,
    providerId,
    modelId,
  });
  const delegatedAgent = createHelarcDelegatedWorkerAgent({ providerId, modelId, instructionSettings });
  const clarification = createHelarcClarificationContribution(admittedAt);
  const descendant = createHelarcDescendantAgentContribution(delegatedAgent, admittedAt, input.executionHandoff, input.contextMaterials, input.materialHandoff);
  const taskFulfillment = createHelarcTaskFulfillmentHookComposition(
    input.provider,
    (instructionSettings ?? createDefaultHelarcInstructionSettings()).stop,
    now,
  );
  const executionCallables = new Map<string, import("../controller/HelarcModelCallableCatalog.js").HelarcModelCallableCatalog>();
  const actions = createHelarcActionComposition({
    contextMaterials: input.contextMaterials,
    executionEvidence: input.executionEvidence,
    executionEvidenceAccess: input.executionEvidenceAccess,
    executionMaterials: input.executionMaterials,
    executionCollections: input.executionCollections,
    executionCallable(runId, binding) {
      const matches = executionCallables.get(runId)?.bindings.filter(entry => entry.kind === "tool" && entry.binding.kind === "operation" &&
        entry.binding.revision === binding.revision && entry.binding.operation.revision === binding.operation.revision &&
        entry.binding.operation.operation.namespace === binding.operation.operation.namespace &&
        entry.binding.operation.operation.name === binding.operation.operation.name) ?? [];
      return matches.length === 1 ? matches[0]!.callableName : null;
    },
    admittedAt,
    file: input.fileActions,
    command: input.commandActions,
    semanticTools: Object.freeze([clarification.tool, ...descendant.tools]),
  });
  const controllerProtocol = createHelarcBaselineControllerProtocolComposition({
    instructionSettings,
    providerId,
    modelId,
    toolSelectionRevision: actions.toolSelection.revision,
    tools: actions.toolSelection.tools.map(({ registration }) => registration),
    shellRuntime: input.commandActions.shellRuntime,
  });
  const rootToolGuidanceBinding = controllerProtocol.bindRun(input.runId);
  assertHelarcProviderCompatibility(input.provider, input.providerProfile);
  const interactions = createInteractionProtocolRegistrySnapshot(
    "helarc.interactions.v3",
    [clarification.protocol],
  );
  const retryClock = createHelarcRetryClock(input.now);
  const controllerTraceByOperationId = new Map<
    string,
    HelarcControllerTraceProjection
  >();
  let productProjection = createHelarcProductRunProjection(
    input.runId,
  );
  let productSequence = 0;
  let activitySequence = 0;
  let activityRootRunId: string | null = null;
  const productListeners = new Set<HelarcProductRunProjectionListener>();
  const publishProductUpdate = (
    update: HelarcProductProjectionUpdatePayload,
  ): void => {
    productSequence += 1;
    const reduction = reduceHelarcProductRunProjection(productProjection, {
      ...update,
      runId: input.runId,
      sequence: productSequence,
    } as Parameters<typeof reduceHelarcProductRunProjection>[1]);
    if (reduction.status === "rejected") {
      throw new Error(`Helarc product projection update was rejected: ${reduction.code}.`);
    }
    productProjection = reduction.projection;
    for (const listener of [...productListeners]) {
      try {
        listener(productProjection);
      } catch {
        // Product projection delivery is non-authoritative.
      }
    }
  };
  const previews = new HelarcResponsePreviewStore(responses => {
    if (!productProjection.result) publishProductUpdate({kind:"responses_observed", responses});
  });
  const continuation = new ModelContinuationLifecycle({
    store: input.modelContinuationStore,
    now: input.now,
    events: Object.freeze({
      publish(event: ModelContinuationSafeEvent) {
        publishProductUpdate({
          kind: "continuation_changed",
          continuation: event,
        });
      },
    }),
  });
  const modelCoordinator = new ModelTaskDecisionCoordinator<HelarcAgentOutput>({
      provider: input.provider,
      contextPreparation: input.contextPreparation,
      delivery: {mode:input.responseDelivery ?? "buffered", observer:{observe:event => previews.observe(event)}},
      buildRequest: (controllerInput, context) => {
        executionCallables.set(controllerInput.runId, controllerProtocol.createCallableCatalog(
          controllerInput.toolExposure, controllerInput.planLimits, controllerInput.plan !== null));
        const request = buildHelarcProviderRequest(
          controllerInput,
          context,
          controllerProtocol,
          {shell: input.commandActions.shellRuntime, cwd: input.commandActions.shellSession?.(controllerInput.runId).canonicalPath ?? null},
        );
        previews.bindRequest(controllerInput.runId, request.requestId,
          controllerProtocol.createCallableCatalog(controllerInput.toolExposure, controllerInput.planLimits, controllerInput.plan !== null));
        return request;
      },
      parseResponse: async (response, controllerInput, executionFlow) =>
        parseHelarcProviderResponse(
          response,
          controllerInput,
          controllerProtocol,
          executionFlow,
          await validateHelarcFinalMaterials(response, controllerInput.runId, input.contextMaterials),
        ),
      responseProtocol: Object.freeze({ kind: "native_tool_turn" }),
      retryExecutor: createSystemRetryExecutor(retryClock),
      retryClock,
      continuation,
    });
  const tracedController = new HelarcTracingController(
    new HelarcProtocolRecoveryController(modelCoordinator),
    controllerTraceByOperationId,
  );
  const providerController = new AgentHookExtensions<HelarcAgentOutput>({
    invocationRecords: input.hookInvocationRecords,
    composition: taskFulfillment.composition,
    rootRunId: input.runId,
    maxConsecutiveContinuations: 2,
    now,
  });
  const runMetadata = Object.freeze({
    product: "helarc",
    instructionTarget: input.instructionTarget,
    controllerProtocolRevision: controllerProtocol.revision,
    toolGuidanceBindingId: rootToolGuidanceBinding.id,
    toolGuidanceReleaseId: rootToolGuidanceBinding.release.id,
    toolGuidanceReleaseRevision: rootToolGuidanceBinding.release.revision,
    toolGuidanceProfileRevision: rootToolGuidanceBinding.guidanceProfileRevision,
    toolGuidanceContentDigest: rootToolGuidanceBinding.contentDigest,
    controllerControlGuidanceRevision: controllerProtocol.controlGuidance.revision,
  });

  return Object.freeze({
    agent,
    delegatedAgent,
    taskDecisions: tracedController,
    extensions: providerController,
    preparations: modelCoordinator.preparations,
    controllerProtocol,
    actions,
    interactions,
    delegation: descendant.delegation,
    agentHooks: providerController.store,
    hookRegistrations: taskFulfillment.composition.registrations,
    taskFulfillment: taskFulfillment.hook,
    runMetadata,
    getProductProjection(): HelarcProductRunProjection {
      return productProjection;
    },
    getResponsePreviews: () => previews.snapshot(),
    subscribeResponsePreviews: (listener: (value: HelarcResponsePreviews, attempt: HelarcResponsePreview) => void) => previews.subscribe(listener),
    recordTranscript(record: RunTranscriptRecord): void {
      if (productProjection.result) return;
      const presentation = appendHelarcRunPresentation(productProjection.presentation, record);
      if (presentation !== productProjection.presentation) publishProductUpdate({ kind: "presentation_observed", presentation });
      previews.committed(record);
    },
    recordRunLineage(runId: string, lineage: RunLineage): void {
      if (productProjection.result) return;
      const presentation = labelHelarcRunPresentation(productProjection.presentation, runId, lineage, input.task.input.prompt);
      if (presentation !== productProjection.presentation) publishProductUpdate({ kind: "presentation_observed", presentation });
    },
    recordRunInput(runId: string, received: RunInput, receivedAt: string): void {
      if (productProjection.result) return;
      const presentation = receiveHelarcRunInputPresentation(productProjection.presentation, runId, received, receivedAt);
      if (presentation !== productProjection.presentation) publishProductUpdate({kind: "presentation_observed", presentation});
    },
    recordCommandProgress(command:Omit<import("../run/HelarcRunProjection.js").HelarcCommandProgress, "origin">):void {
      if(productProjection.result!==null||productProjection.commands.some(item=>item.executionId===command.executionId&&item.revision>=command.revision))return;
      publishProductUpdate({kind:"command_observed",command});
    },
    subscribeProductProjection(listener: HelarcProductRunProjectionListener): () => void {
      if (typeof listener !== "function") {
        throw new TypeError("Helarc product projection listener must be a function.");
      }
      productListeners.add(listener);
      return () => {
        productListeners.delete(listener);
      };
    },
    recordRuntimeEvent(event: RuntimeEvent) {
      const eventRootRunId = event.lineage.root.id;
      if (activityRootRunId === null && event.lineage.kind !== "root") {
        throw new TypeError("The first Helarc activity Event must establish root Run lineage.");
      }
      if (activityRootRunId !== null && eventRootRunId !== activityRootRunId) {
        throw new TypeError("Helarc activity cannot combine different Run Tree roots.");
      }
      if (event.name === "operation.started" && !productProjection.result) {
        const presentation = associateHelarcOperationPresentation(productProjection.presentation, event);
        if (presentation !== productProjection.presentation) publishProductUpdate({kind: "presentation_observed", presentation});
      }
      const controllerTrace = projectHelarcControllerTraceForEvent(
        event,
        controllerTraceByOperationId,
      );
      const nextActivitySequence = activitySequence + 1;
      const activity = mapRuntimeEventToHelarcActivity(
        event,
        nextActivitySequence,
        controllerTrace,
      );
      publishProductUpdate({ kind: "activity_appended", activity });
      activityRootRunId ??= eventRootRunId;
      activitySequence = nextActivitySequence;
      return Object.freeze({ event, activity });
    },
    projectResult(
      runResult: RunResult<HelarcAgentOutput>,
      selectedEnforcement: SandboxEnforcement,
    ): HelarcProductResult {
      previews.close();
      const flow = new ExecutionFlowPath(HELARC_RESULT_EXECUTION_FLOW, input.executionFlow ?? {}, runResult.runId, [{owner:"runtime",kind:"run",id:runResult.runId,revision:null}]);
      const inputRef = flow.material("Run result for Product projection", "received", runResult);
      flow.advance("result", {status:runResult.status}, [inputRef]);
      try {
      const projectionStep = flow.advance("project", {}, [inputRef]);
      const result = projectHelarcProductResult(
        input.task,
        input.workspace,
        runResult,
        selectedEnforcement,
      );
      const resultRef = flow.material("Helarc Product result", "projected", result);
      projectionStep.output(resultRef);
      const deliveryStep = flow.advance("deliver", {productStatus:result.status}, [resultRef]);
      publishProductUpdate({ kind: "result_settled", result });
      deliveryStep.output(resultRef);
      flow.close("returned");
      return result;
      } catch (error) {flow.close("failed");throw error;}
    },
  });
}

function createHelarcRetryClock(
  now: CreateHelarcProductCompositionInput["now"],
): RetryClock {
  return now === undefined
    ? systemRetryClock
    : Object.freeze({ now: () => new Date(now()) });
}
