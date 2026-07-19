import {
  ProviderBackedController,
  createSystemRetryExecutor,
  systemRetryClock,
} from "@agent-anything/agent-runtime";
import type {
  Agent,
  AgentTask,
  Controller,
  RetryClock,
  RunResult,
  RuntimeEvent,
  SandboxEnforcement,
} from "@agent-anything/agent-core";
import type { CodeAgentCommandLimits } from "@agent-anything/code-agent";
import type { Provider } from "@agent-anything/providers";
import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { ToolDescriptor } from "@agent-anything/tools";
import {
  buildHelarcProviderRequest,
  createHelarcToolCatalogMetadata,
  HELARC_ACTION_CONTRACT_VERSION,
  HELARC_CONTROLLER_OUTPUT_MAX_LENGTH,
  HELARC_TOOL_CATALOG_METADATA_KEY,
  parseHelarcProviderResponse,
  type HelarcAgentOutput,
  type HelarcChangeIntent,
} from "../controller/index.js";
import {
  enrichRuntimeEventWithControllerTrace,
  HelarcTracingController,
} from "../run/HelarcControllerTraceProjection.js";
import { HelarcPatchActionController } from "../patch/HelarcPatchActionController.js";
import type { HelarcTaskInput } from "../task/index.js";
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
  const actions = await createHelarcActionComposition(input.task, {
    enableShell: input.toolMode === "shell-enabled",
    commandLimits: input.commandLimits,
  });
  const retryClock = createHelarcRetryClock(input.now);
  const controllerTraceByIteration = new Map<number, Metadata>();
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
    controllerTraceByIteration,
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
      tools: actions.exposedCatalog.tools,
    }),
  });

  return Object.freeze({
    agent: createHelarcAgent(actions.agentTools),
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
      const projected = enrichRuntimeEventWithControllerTrace(event, controllerTraceByIteration);
      const activity = mapRuntimeEventToHelarcActivity(projected);
      publishProductUpdate({ kind: "activity_appended", activity });
      return Object.freeze({ event: projected, activity });
    },
    projectResult(
      runResult: RunResult<HelarcAgentOutput>,
      selectedEnforcement: SandboxEnforcement,
    ): HelarcProductResult {
      const result = projectHelarcProductResult(
        input.task,
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

function createHelarcAgent(
  tools: readonly ToolDescriptor[],
): Agent<HelarcAgentOutput> {
  return Object.freeze({
    id: "helarc-code-agent",
    name: "Helarc",
    instructions: "Complete the requested code task within the active workspace and safety boundaries.",
    tools: Object.freeze([...tools]),
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
