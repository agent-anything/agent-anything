import { ProviderBackedController } from "@agent-anything/agent-runtime/controller";
import { createSystemRetryExecutor, systemRetryClock } from "@agent-anything/agent-runtime/retry";
import type { Controller } from "@agent-anything/agent-runtime/controller";
import type { RunResult } from "@agent-anything/agent-runtime/run";
import type { RunnerDelegationComposition } from "@agent-anything/agent-runtime/runner";
import type { RuntimeEvent } from "@agent-anything/observability/events";
import type { VerificationHostProjection } from "@agent-anything/verification/projection";
import type { Agent } from "@agent-anything/agent-core/agent";
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
import {
  HelarcTracingController,
  projectHelarcControllerTraceForEvent,
  type HelarcControllerTraceProjection,
} from "../observability/index.js";
import type { HelarcTaskInput } from "../task/HelarcTaskInput.js";
import type { HelarcProviderProfile } from "../configuration/index.js";
import {
  type HelarcModelQualificationCatalog,
  type HelarcModelQualificationResolution,
} from "../model-qualification/index.js";
import {
  admitHelarcModelUse,
  resolveHelarcModelQualification,
} from "./HelarcModelUseAdmission.js";
import type { Provider } from "@agent-anything/model-interaction";
import {
  createHelarcVerificationComposition,
  type HelarcExactTargetVerificationRequirement,
  type HelarcVerificationComposition,
} from "../verification/index.js";
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
import { HelarcTaskFulfillmentEvaluator } from "../task-fulfillment/index.js";
import type { TaskFulfillmentEvaluatorPort } from "@agent-anything/agent-runtime/completion";

type HelarcProductProjectionUpdatePayload =
  HelarcProductRunProjectionUpdate extends infer TUpdate
    ? TUpdate extends HelarcProductRunProjectionUpdate
      ? Omit<TUpdate, "runId" | "sequence">
      : never
    : never;

export interface CreateHelarcProductCompositionInput {
  readonly runId: string;
  readonly task: AgentTask<HelarcTaskInput>;
  readonly workspace: WorkspaceSelection;
  readonly provider: Provider;
  readonly providerProfile: HelarcProviderProfile;
  readonly qualificationCatalog?: HelarcModelQualificationCatalog;
  readonly instructionTarget: HelarcMainInstructionTarget;
  readonly codeSource: CodeSourcePort;
  readonly fileActions: HelarcFileActionContribution;
  readonly commandActions: HelarcCommandActionContribution;
  readonly verificationTargets?: readonly HelarcExactTargetVerificationRequirement[];
  readonly modelContinuationStore?: ModelContinuationStore;
  readonly now?: () => string;
}

export interface HelarcProductComposition {
  readonly agent: Agent<HelarcAgentOutput>;
  readonly delegatedAgent: Agent<HelarcAgentOutput>;
  readonly controller: Controller<HelarcAgentOutput>;
  readonly controllerProtocol: HelarcControllerProtocolComposition;
  readonly qualification: HelarcModelQualificationResolution;
  readonly actions: Awaited<ReturnType<typeof createHelarcActionComposition>>;
  readonly interactions: InteractionProtocolRegistrySnapshot;
  readonly delegation: RunnerDelegationComposition;
  readonly verification: HelarcVerificationComposition;
  readonly taskFulfillment: TaskFulfillmentEvaluatorPort;
  readonly runMetadata: Readonly<Record<string, unknown>>;
  getProductProjection(): HelarcProductRunProjection;
  subscribeProductProjection(listener: HelarcProductRunProjectionListener): () => void;
  recordRuntimeEvent(event: RuntimeEvent): {
    readonly event: RuntimeEvent;
    readonly activity: HelarcActivityItem;
  };
  projectResult(
    runResult: RunResult<HelarcAgentOutput>,
    selectedEnforcement: SandboxEnforcement,
    verification: VerificationHostProjection | null,
  ): HelarcProductResult;
}

export async function createHelarcProductComposition(
  input: CreateHelarcProductCompositionInput,
): Promise<HelarcProductComposition> {
  const now = input.now ?? (() => new Date().toISOString());
  const admittedAt = now();
  const providerId = input.provider.descriptor.id;
  const modelId = input.provider.inputAccounting.model;
  if (providerId !== input.provider.inputAccounting.providerId) {
    throw new TypeError("Helarc Provider descriptor and Model Input Accounting identities differ.");
  }
  const agent = createHelarcAgent({
    target: input.instructionTarget,
    providerId,
    modelId,
  });
  const delegatedAgent = createHelarcDelegatedWorkerAgent({ providerId, modelId });
  const clarification = createHelarcClarificationContribution(admittedAt);
  const descendant = createHelarcDescendantAgentContribution(delegatedAgent, admittedAt);
  const verification = await createHelarcVerificationComposition({
    workspace: input.workspace,
    codeSource: input.codeSource,
    commandEnvironment: input.commandActions.environment,
    exactTargets: input.verificationTargets,
    admittedAt,
    now,
  });
  const taskFulfillment = new HelarcTaskFulfillmentEvaluator(input.provider, now);
  const actions = createHelarcActionComposition({
    admittedAt,
    file: input.fileActions,
    command: input.commandActions,
    semanticTools: Object.freeze([clarification.tool, ...descendant.tools]),
  });
  const controllerProtocol = createHelarcBaselineControllerProtocolComposition({
    providerId,
    modelId,
    toolSelectionRevision: actions.toolSelection.revision,
    tools: actions.toolSelection.tools.map(({ registration }) => registration),
  });
  const rootToolGuidanceBinding = controllerProtocol.bindRun(input.runId);
  const qualification = resolveHelarcModelQualification({
    provider: input.provider,
    providerProfile: input.providerProfile,
    agent,
    controllerProtocol,
    catalog: input.qualificationCatalog,
  });
  admitHelarcModelUse(qualification);
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
    qualification.safeProjection,
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
  const providerController = new HelarcTracingController(
    new ProviderBackedController<HelarcAgentOutput>({
      provider: input.provider,
      buildRequest: (controllerInput, context) =>
        buildHelarcProviderRequest(
          controllerInput,
          context,
          controllerProtocol,
          qualification,
        ),
      parseResponse: (response, controllerInput) =>
        parseHelarcProviderResponse(
          response,
          controllerInput,
          controllerProtocol,
          qualification,
        ),
      responseProtocol: Object.freeze({ kind: "native_tool_turn" }),
      retryExecutor: createSystemRetryExecutor(retryClock),
      retryClock,
      continuation,
    }),
    controllerTraceByOperationId,
  );
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
    modelQualificationTargetId: qualification.target.id,
    modelUseDispositionId: qualification.disposition.id,
    modelUseDispositionStatus: qualification.disposition.status,
    modelQualificationPolicy: qualification.disposition.policy,
    modelQualificationScopes: qualification.requiredScopes,
    modelQualificationReasons: qualification.disposition.reasons,
  });

  return Object.freeze({
    agent,
    delegatedAgent,
    controller: providerController,
    controllerProtocol,
    qualification,
    actions,
    interactions,
    delegation: descendant.delegation,
    verification,
    taskFulfillment,
    runMetadata,
    getProductProjection(): HelarcProductRunProjection {
      return productProjection;
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
      verificationProjection: VerificationHostProjection | null,
    ): HelarcProductResult {
      const result = projectHelarcProductResult(
        input.task,
        input.workspace,
        runResult,
        selectedEnforcement,
        verificationProjection,
        qualification.safeProjection,
      );
      publishProductUpdate({ kind: "result_settled", result });
      return result;
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
