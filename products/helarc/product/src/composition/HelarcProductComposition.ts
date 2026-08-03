import {
  ProviderBackedController,
  createSystemRetryExecutor,
  systemRetryClock,
} from "@agent-anything/runtime";
import type {
  Controller,
  RunResult,
} from "@agent-anything/runtime";
import type { RuntimeEvent } from "@agent-anything/observability/events";
import type {
  Agent,
  AgentTask,
  ISODateTimeString,
  Metadata,
  RunWorkspace,
} from "@agent-anything/foundation";
import type { RetryClock } from "@agent-anything/runtime/retry";
import type { SandboxEnforcement } from "@agent-anything/action-execution";
import type { CodeAgentCommandLimits } from "@agent-anything/helarc-code-agent/command";
import type { Provider } from "@agent-anything/model-interaction";
import {
  buildHelarcProviderRequest,
  HELARC_CONTROLLER_OUTPUT_MAX_LENGTH,
  parseHelarcProviderResponse,
  type HelarcAgentOutput,
  type HelarcChangeIntent,
} from "../controller/HelarcController.js";
import { HELARC_ACTION_CONTRACT_VERSION } from "../controller/HelarcPromptAssembly.js";
import {
  createHelarcToolCatalogMetadata,
  HELARC_TOOL_CATALOG_METADATA_KEY,
} from "../controller/HelarcToolCatalog.js";
import {
  HelarcTracingController,
  projectHelarcControllerTraceForEvent,
  type HelarcControllerTraceProjection,
} from "../run/HelarcControllerTraceProjection.js";
import { HelarcPatchActionController } from "../patch/HelarcPatchActionController.js";
import type { HelarcTaskInput } from "../task/HelarcTaskInput.js";
import type { HelarcPatchReviewBridge } from "./HelarcPatchReview.js";
import { createHelarcActionComposition } from "./HelarcActionComposition.js";
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

export type HelarcToolMode = "read-only" | "shell-enabled";

export interface CreateHelarcProductCompositionInput {
  readonly runId: string;
  readonly task: AgentTask<HelarcTaskInput>;
  readonly workspace: RunWorkspace;
  readonly provider: Provider;
  readonly toolMode: HelarcToolMode;
  readonly commandLimits?: Partial<CodeAgentCommandLimits>;
  readonly patchReviewBridge?: HelarcPatchReviewBridge;
  readonly now?: () => ISODateTimeString;
}

export interface HelarcProductComposition {
  readonly agent: Agent<HelarcAgentOutput>;
  readonly controller: Controller<HelarcAgentOutput>;
  readonly actions: Awaited<ReturnType<typeof createHelarcActionComposition>>;
  readonly runMetadata: Metadata;
  getProductProjection(): HelarcProductRunProjection;
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
  const actions = await createHelarcActionComposition(input.workspace, {
    enableShell: input.toolMode === "shell-enabled",
    commandLimits: input.commandLimits,
  });
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
  const providerController = new HelarcTracingController(
    new ProviderBackedController<HelarcAgentOutput>({
      provider: input.provider,
      buildRequest: buildHelarcProviderRequest,
      parseResponse: parseHelarcProviderResponse,
      structuredOutputContractId: HELARC_ACTION_CONTRACT_VERSION,
      maxProviderOutputLength: HELARC_CONTROLLER_OUTPUT_MAX_LENGTH,
      retryExecutor: createSystemRetryExecutor(retryClock),
      retryClock,
    }),
    controllerTraceByOperationId,
  );
  const patchController = new HelarcPatchActionController({
    controller: providerController,
    patchReviewBridge: input.patchReviewBridge,
    onPhaseChanged: (phase) => {
      publishProductUpdate({ kind: "phase_changed", phase });
    },
    now: input.now,
  });
  const unsubscribePatchReview = input.patchReviewBridge?.subscribe((review) => {
    if (review !== null) {
      if (productProjection.phase.kind !== "patch_action_submitted") {
        publishProductUpdate({
          kind: "phase_changed",
          phase: Object.freeze({ kind: "waiting_for_patch_review", review }),
        });
      }
      return;
    }
    if (productProjection.phase.kind === "waiting_for_patch_review") {
      publishProductUpdate({ kind: "phase_changed", phase: Object.freeze({ kind: "none" }) });
    }
  }) ?? (() => undefined);
  const runMetadata = Object.freeze({
    product: "helarc",
    toolMode: input.toolMode,
    [HELARC_TOOL_CATALOG_METADATA_KEY]: createHelarcToolCatalogMetadata({
      mode: input.toolMode,
    }),
  });

  return Object.freeze({
    agent: createHelarcAgent(),
    controller: patchController,
    actions,
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
    ): HelarcProductResult {
      const result = projectHelarcProductResult(
        input.task,
        input.workspace,
        runResult,
        patchController.getPatchOutcome(),
        selectedEnforcement,
      );
      publishProductUpdate({ kind: "result_settled", result });
      unsubscribePatchReview();
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

function createHelarcAgent(): Agent<HelarcAgentOutput> {
  return Object.freeze({
    id: "helarc-code-agent",
    name: "Helarc",
    instructions: "Complete the requested code task within the active workspace and safety boundaries.",
    output: Object.freeze({
      validate(candidate: unknown) {
        if (!isRecord(candidate) || typeof candidate.summary !== "string") {
          return { valid: false as const, message: "Helarc output requires a summary." };
        }
        if (candidate.kind === "complete") {
          return {
            valid: true as const,
            output: Object.freeze({ kind: "complete" as const, summary: candidate.summary }),
          };
        }
        if (candidate.kind !== "propose" || !isRecord(candidate.change)) {
          return { valid: false as const, message: "Helarc output kind is invalid." };
        }
        const operation = candidate.change.operation;
        const path = candidate.change.path;
        const content = candidate.change.content;
        if (
          (operation !== "create" && operation !== "update" && operation !== "delete")
          || typeof path !== "string"
          || ((operation === "create" || operation === "update") && typeof content !== "string")
        ) {
          return { valid: false as const, message: "Helarc proposed change is invalid." };
        }
        const change: HelarcChangeIntent = operation === "delete"
          ? { operation, path }
          : { operation, path, content: content as string };
        return {
          valid: true as const,
          output: Object.freeze({
            kind: "propose" as const,
            summary: candidate.summary,
            change: Object.freeze(change),
          }),
        };
      },
    }),
    metadata: Object.freeze({ product: "helarc" }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
