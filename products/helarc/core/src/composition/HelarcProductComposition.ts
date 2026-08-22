import { ProviderBackedController } from "@agent-anything/agent-runtime/controller";
import { createSystemRetryExecutor, systemRetryClock } from "@agent-anything/agent-runtime/retry";
import type { Controller } from "@agent-anything/agent-runtime/controller";
import type { RunResult } from "@agent-anything/agent-runtime/run";
import type { DescendantRunCompositionPort } from "@agent-anything/agent-runtime/runner";
import type { RuntimeEvent } from "@agent-anything/observability/events";
import type { ValidationHostProjection } from "@agent-anything/validation/projection";
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
  HELARC_CONTROLLER_OUTPUT_MAX_LENGTH,
  parseHelarcProviderResponse,
  type HelarcAgentOutput,
} from "../controller/HelarcController.js";
import { createHelarcAgent } from "../agent/HelarcAgent.js";
import { createHelarcDescendantAgentContribution } from "../agent/HelarcDescendantAgent.js";
import { HELARC_ACTION_CONTRACT_VERSION } from "../prompt/HelarcPromptAssembly.js";
import {
  HelarcTracingController,
  projectHelarcControllerTraceForEvent,
  type HelarcControllerTraceProjection,
} from "../observability/index.js";
import type { HelarcTaskInput } from "../task/HelarcTaskInput.js";
import type { Provider } from "@agent-anything/model-interaction";
import {
  createHelarcValidationComposition,
  type HelarcExactTargetValidationRequirement,
  type HelarcValidationComposition,
} from "../validation/index.js";
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
  readonly codeSource: CodeSourcePort;
  readonly fileActions: HelarcFileActionContribution;
  readonly commandActions: HelarcCommandActionContribution;
  readonly validationTargets?: readonly HelarcExactTargetValidationRequirement[];
  readonly modelContinuationStore?: ModelContinuationStore;
  readonly now?: () => string;
}

export interface HelarcProductComposition {
  readonly agent: Agent<HelarcAgentOutput>;
  readonly controller: Controller<HelarcAgentOutput>;
  readonly actions: Awaited<ReturnType<typeof createHelarcActionComposition>>;
  readonly interactions: InteractionProtocolRegistrySnapshot;
  readonly descendants: DescendantRunCompositionPort;
  readonly validation: HelarcValidationComposition;
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
    validation: ValidationHostProjection | null,
  ): HelarcProductResult;
}

export async function createHelarcProductComposition(
  input: CreateHelarcProductCompositionInput,
): Promise<HelarcProductComposition> {
  const now = input.now ?? (() => new Date().toISOString());
  const admittedAt = now();
  const agent = createHelarcAgent();
  const clarification = createHelarcClarificationContribution(admittedAt);
  const descendant = createHelarcDescendantAgentContribution(agent, admittedAt, now);
  const validation = await createHelarcValidationComposition({
    workspace: input.workspace,
    codeSource: input.codeSource,
    commandEnvironment: input.commandActions.environment,
    exactTargets: input.validationTargets,
    admittedAt,
    now,
  });
  const actions = createHelarcActionComposition({
    admittedAt,
    file: input.fileActions,
    command: input.commandActions,
    semanticTools: Object.freeze([clarification.tool, descendant.tool]),
  });
  const interactions = createInteractionProtocolRegistrySnapshot(
    "helarc.interactions.v3",
    [clarification.protocol],
  );
  const retryClock = createHelarcRetryClock(input.now);
  const controllerTraceByOperationId = new Map<
    string,
    HelarcControllerTraceProjection
  >();
  let productProjection = createHelarcProductRunProjection(input.runId);
  let productSequence = 0;
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
      buildRequest: buildHelarcProviderRequest,
      parseResponse: parseHelarcProviderResponse,
      structuredOutputContractId: HELARC_ACTION_CONTRACT_VERSION,
      maxProviderOutputLength: HELARC_CONTROLLER_OUTPUT_MAX_LENGTH,
      retryExecutor: createSystemRetryExecutor(retryClock),
      retryClock,
      continuation,
    }),
    controllerTraceByOperationId,
  );
  const runMetadata = Object.freeze({
    product: "helarc",
  });

  return Object.freeze({
    agent,
    controller: providerController,
    actions,
    interactions,
    descendants: descendant.composition,
    validation,
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
      const controllerTrace = projectHelarcControllerTraceForEvent(
        event,
        controllerTraceByOperationId,
      );
      const activity = mapRuntimeEventToHelarcActivity(event, controllerTrace);
      publishProductUpdate({ kind: "activity_appended", activity });
      return Object.freeze({ event, activity });
    },
    projectResult(
      runResult: RunResult<HelarcAgentOutput>,
      selectedEnforcement: SandboxEnforcement,
      validationProjection: ValidationHostProjection | null,
    ): HelarcProductResult {
      const result = projectHelarcProductResult(
        input.task,
        input.workspace,
        runResult,
        selectedEnforcement,
        validationProjection,
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
