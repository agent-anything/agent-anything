import {
  ProviderBackedController,
  createSystemRetryExecutor,
  systemRetryClock,
  type Agent,
  type AgentTask,
  type Controller,
  type RetryClock,
  type RunResult,
  type RuntimeEvent,
  type SandboxEnforcement,
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
import type {
  HelarcPatchReviewBridge,
  HelarcProductPhase,
} from "./HelarcPatchReview.js";
import { createHelarcActionComposition } from "./HelarcActionComposition.js";
import {
  projectHelarcProductResult,
  type HelarcProductResult,
} from "./HelarcProductResult.js";

export type HelarcToolMode = "read-only" | "shell-enabled";

export interface CreateHelarcProductCompositionInput {
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
  getProductPhase(): HelarcProductPhase;
  projectRuntimeEvent(event: RuntimeEvent): RuntimeEvent;
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
    now: input.now,
  });
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
    getProductPhase(): HelarcProductPhase {
      return patchController.getProductPhase();
    },
    projectRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
      return enrichRuntimeEventWithControllerTrace(event, controllerTraceByIteration);
    },
    projectResult(
      runResult: RunResult<HelarcAgentOutput>,
      selectedEnforcement: SandboxEnforcement,
    ): HelarcProductResult {
      return projectHelarcProductResult(
        input.task,
        runResult,
        patchController.getPatchOutcome(),
        selectedEnforcement,
      );
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
