import type {
  ControllerDecision,
  ControllerInput,
  ControllerModelItem,
  ProgressionCandidate,
} from "@agent-anything/agent-runtime/controller";
import { StructuredOutputError, type ProviderRequestBuildContext, type StructuredOutputFailure } from "@agent-anything/agent-runtime/controller";
import type { ProviderRequest, ProviderResponse } from "@agent-anything/model-interaction";
import {
  composeModelInput,
  providerMessagesFromComposition,
} from "@agent-anything/model-interaction/input";

import {
  buildHelarcPromptAssembly,
  HELARC_ACTION_CONTRACT_VERSION,
  HELARC_MODEL_OUTPUT_RESERVE_BYTES,
  HELARC_PROMPT_ARCHITECTURE_VERSION,
  HELARC_TOOL_EXPOSURE_VERSION,
} from "../prompt/HelarcPromptAssembly.js";
import {
  HelarcModelDecisionError,
  parseHelarcModelDecision,
  type HelarcModelDecision,
  type HelarcModelDecisionErrorCode,
} from "./HelarcModelDecision.js";
import { createHelarcControllerOutputFormat } from "./HelarcActionContract.js";

export const HELARC_CONTROLLER_CAPABILITY = "helarc.code-agent.turn";
export const HELARC_CONTROLLER_OUTPUT_MAX_LENGTH = 64_000;
export type HelarcAgentOutput = { kind: "complete"; summary: string };

export type HelarcProviderStructuredOutput = HelarcModelDecision;

class HelarcInstructionModelMismatchError extends TypeError {
  readonly code = "agent_instruction_model_mismatch";

  constructor() {
    super("Active Agent instructions, instruction binding, and Provider model must match.");
    this.name = "HelarcInstructionModelMismatchError";
  }
}

export type HelarcControllerParseErrorCode =
  | "controller_output_too_large"
  | "controller_output_not_json"
  | "controller_output_invalid"
  | "controller_tool_name_unsupported"
  | HelarcModelDecisionErrorCode;

export class HelarcControllerParseError extends StructuredOutputError {
  constructor(readonly code: HelarcControllerParseErrorCode) {
    super(helarcStructuredOutputFailure(code));
    this.name = "HelarcControllerParseError";
  }
}

export function buildHelarcProviderRequest(
  input: ControllerInput<HelarcAgentOutput>,
  context: ProviderRequestBuildContext,
): ProviderRequest {
  assertInstructionModelIdentity(input, context);
  const outputFormat = createHelarcControllerOutputFormat(input.toolExposure);
  const correctionMessage = context.correction === null
    ? null
    : buildHelarcCorrectionMessage(context.correction.failure);
  const promptAssembly = buildHelarcPromptAssembly({
    controllerInput: input,
    correctionMessage,
  });
  const composition = composeModelInput({
    id: `${input.runId}:model-input:${input.iteration}:${context.attemptNumber}`,
    providerId: context.inputAccounting.providerId,
    model: context.inputAccounting.model,
    accounting: context.inputAccounting,
    outputFormat,
    outputReserve: Object.freeze({
      unit: input.contextManifest.budget.unit,
      amount: HELARC_MODEL_OUTPUT_RESERVE_BYTES,
    }),
    contextBudget: Object.freeze({
      unit: input.contextManifest.budget.unit,
      amount: input.contextManifest.budget.maximum,
    }),
    contextProjectedAmount: input.context.accounting.amount,
    sections: promptAssembly.sections,
    lineage: Object.freeze({
      instructionBinding: Object.freeze({
        owner: "agent-runtime",
        kind: "agent_instruction_binding",
        id: input.instructionBinding.ref.id,
        revision: input.instructionBinding.ref.revision,
      }),
      agent: Object.freeze({
        owner: "agent-core",
        kind: "agent_revision",
        id: input.agent.id,
        revision: input.agent.revision,
      }),
      instructions: Object.freeze({
        owner: "agent-core",
        kind: "agent_instructions",
        id: input.agent.instructions.ref.id,
        revision: input.agent.instructions.ref.revision,
      }),
      instructionRelease: Object.freeze({
        owner: "helarc",
        kind: "agent_instruction_release",
        id: input.agent.instructions.release.id,
        revision: input.agent.instructions.release.revision,
      }),
      instructionResolver: Object.freeze({
        owner: "helarc",
        kind: "agent_instruction_resolver",
        id: `${input.agent.instructions.release.id}:resolver`,
        revision: input.agent.instructions.resolverRevision,
      }),
      instructionContent: Object.freeze({
        owner: "agent-core",
        kind: "agent_instruction_content_digest",
        id: input.agent.instructions.ref.id,
        revision: `sha256:${input.agent.instructions.contentDigest.value}`,
      }),
      instructionModel: Object.freeze({
        providerId: input.agent.instructions.model.providerId,
        model: input.agent.instructions.model.modelId,
      }),
      instructionBlocks: Object.freeze(input.agent.instructions.blocks.map((block) =>
        Object.freeze({
          owner: block.source.owner,
          kind: block.source.kind,
          id: block.source.id,
          revision: block.source.revision,
        })
      )),
      activeContext: Object.freeze({
        owner: "context",
        kind: "active_context",
        id: input.context.activeContext.id,
        revision: String(input.context.activeContext.version),
      }),
      contextProjection: Object.freeze({
        owner: "context",
        kind: "context_projection",
        id: input.context.id,
        revision: String(input.context.activeContext.version),
      }),
      projectionManifest: Object.freeze({
        owner: "context",
        kind: "projection_manifest",
        id: input.contextManifest.id,
        revision: String(input.contextManifest.activeContext.version),
      }),
      toolSelection: Object.freeze({
        owner: "tools",
        kind: "tool_selection",
        id: input.toolExposure.selectionRevision,
        revision: input.toolExposure.selectionRevision,
      }),
      toolExposureContent: Object.freeze({
        owner: "tools",
        kind: "tool_exposure_content",
        id: input.toolExposure.contentRevision,
        revision: input.toolExposure.contentRevision,
      }),
      toolExposureBasis: Object.freeze({
        owner: "tools",
        kind: "tool_exposure_basis",
        id: input.toolExposure.basisRevision,
        revision: input.toolExposure.basisRevision,
      }),
      toolExposureProof: Object.freeze({
        owner: "tools",
        kind: "tool_exposure_proof",
        id: input.toolExposure.id,
        revision: input.toolExposure.id,
      }),
      protocol: Object.freeze({
        owner: "helarc",
        kind: "action_contract",
        id: HELARC_ACTION_CONTRACT_VERSION,
        revision: HELARC_ACTION_CONTRACT_VERSION,
      }),
      policy: Object.freeze({
        owner: "context",
        kind: "projection_policy",
        id: input.contextManifest.policy.id,
        revision: input.contextManifest.policy.revision,
      }),
    }),
    composedAt: input.context.createdAt,
  });

  return {
    capability: HELARC_CONTROLLER_CAPABILITY,
    outputFormat,
    metadata: {
      runId: input.runId,
      controllerIteration: input.iteration,
      taskId: input.task.id,
      taskKind: input.task.kind,
      promptArchitectureVersion: promptAssembly.versions.promptArchitectureVersion,
      actionContractVersion: promptAssembly.versions.actionContractVersion,
      toolExposureVersion: promptAssembly.versions.toolExposureVersion,
      toolSelectionRevision: input.toolExposure.selectionRevision,
      toolExposureContentRevision: input.toolExposure.contentRevision,
      toolExposureBasisRevision: input.toolExposure.basisRevision,
      toolExposureProofId: input.toolExposure.id,
      exposedToolCount: input.toolExposure.exposedTools.length,
      omittedToolCount: input.toolExposure.omittedToolCount,
      toolExposureOmissionReasons: input.toolExposure.omissionReasons,
      exposedToolNames: promptAssembly.exposedToolNames,
      promptSectionIds: promptAssembly.promptSections.map((section) => section.id),
      instructionBindingId: input.instructionBinding.ref.id,
      instructionBindingRevision: input.instructionBinding.ref.revision,
      instructionBindingEffectiveFromRunRevision:
        input.instructionBinding.effectiveFromRunRevision,
      instructionBindingSupersedesId: input.instructionBinding.supersedes?.id ?? null,
      instructionBindingSupersedesRevision:
        input.instructionBinding.supersedes?.revision ?? null,
      agentId: input.agent.id,
      agentRevision: input.agent.revision,
      agentInstructionsId: input.agent.instructions.ref.id,
      agentInstructionsRevision: input.agent.instructions.ref.revision,
      agentInstructionReleaseId: input.agent.instructions.release.id,
      agentInstructionReleaseRevision: input.agent.instructions.release.revision,
      agentInstructionResolverRevision: input.agent.instructions.resolverRevision,
      agentInstructionContentDigest: input.agent.instructions.contentDigest.value,
      agentInstructionBlockCount: input.agent.instructions.blocks.length,
      agentInstructionProviderId: input.agent.instructions.model.providerId,
      agentInstructionModelId: input.agent.instructions.model.modelId,
      modelInputCompositionId: composition.id,
      contextProjectionId: input.context.id,
      contextManifestId: input.contextManifest.id,
      structuredOutputAttemptNumber: context.attemptNumber,
      ...(context.correction === null ? {} : {
        structuredOutputCorrectionCategory: context.correction.failure.category,
        structuredOutputCorrectionCode: context.correction.failure.code,
      }),
    },
    messages: providerMessagesFromComposition(composition.sections).map((message) =>
      message.metadata.modelInputSectionId === "helarc:model-input:structured_output_correction"
        ? Object.freeze({
            ...message,
            metadata: Object.freeze({
              ...message.metadata,
              kind: "structured-output-correction",
            }),
          })
        : message
    ),
    composition,
    continuation: null,
  };
}

function helarcStructuredOutputFailure(
  code: HelarcControllerParseErrorCode,
): StructuredOutputFailure {
  switch (code) {
    case "controller_output_not_json":
      return {
        category: "structured_output_syntax",
        code,
        correctionFeedback: "Return one valid JSON object without markdown or surrounding text.",
      };
    case "controller_output_too_large":
      return {
        category: "structured_output_size",
        code,
        correctionFeedback: "Return a shorter JSON object within the configured output limit.",
      };
    case "controller_tool_name_unsupported":
      return {
        category: "structured_output_semantic",
        code,
        correctionFeedback: "Use only a Tool exposed in the active Tool catalog.",
      };
    default:
      return {
        category: "structured_output_schema",
        code,
        correctionFeedback: "Return one JSON object that satisfies the active Helarc action contract.",
      };
  }
}

function assertInstructionModelIdentity(
  input: ControllerInput<HelarcAgentOutput>,
  context: ProviderRequestBuildContext,
): void {
  const model = input.agent.instructions.model;
  if (
    input.instructionBinding.model.providerId !== model.providerId ||
    input.instructionBinding.model.modelId !== model.modelId ||
    context.inputAccounting.providerId !== model.providerId ||
    context.inputAccounting.model !== model.modelId
  ) {
    throw new HelarcInstructionModelMismatchError();
  }
}

function buildHelarcCorrectionMessage(failure: StructuredOutputFailure): string {
  return [
    "Correct the previous response.",
    `Issue category: ${failure.category}`,
    `Issue code: ${failure.code}`,
    failure.correctionFeedback,
    "Return only the corrected JSON object.",
  ].join("\n");
}

export function parseHelarcProviderResponse(
  response: ProviderResponse,
  input: ControllerInput<HelarcAgentOutput>,
): ControllerDecision<HelarcAgentOutput> {
  const output = parseStructuredOutput(response.output);
  const modelItem = createModelItem(output, input);
  const modelItems = Object.freeze([modelItem]) as readonly [ControllerModelItem];

  switch (output.kind) {
    case "tool_call":
      assertToolNameSupported(output.toolName, input);
      return Object.freeze({
        kind: "advance",
        candidates: oneCandidate(Object.freeze({
          kind: "tool_request" as const,
          tool: Object.freeze({
            name: output.toolName,
            revision: null,
            input: output.input,
            origin: "model" as const,
            controllerRequestId: input.toolExposure.controllerRequestId,
          }),
          modelItemId: modelItem.id,
        })),
        modelItems,
      });

    case "plan_update":
      return Object.freeze({
        kind: "advance",
        candidates: oneCandidate(Object.freeze({
          kind: "state_transition" as const,
          transition: "plan_update" as const,
          input: Object.freeze({
            ...(output.explanation === undefined
              ? {}
              : { explanation: output.explanation }),
            plan: output.plan,
          }),
          modelItemId: modelItem.id,
        })),
        modelItems,
      });

    case "stop":
      return Object.freeze({ kind: "propose_stop", reason: output.reason, modelItems });

    case "completion":
      return Object.freeze({
        kind: "propose_completion",
        output: Object.freeze({ kind: "complete", summary: output.summary }),
        modelItems,
      });

  }
}

export function parseStructuredOutput(output: unknown): HelarcProviderStructuredOutput {
  const value = normalizeProviderOutput(output);
  try {
    return parseHelarcModelDecision(value);
  } catch (error) {
    if (error instanceof HelarcModelDecisionError) {
      throw new HelarcControllerParseError(error.code);
    }
    throw new HelarcControllerParseError("controller_output_invalid");
  }
}

function createModelItem(
  output: HelarcProviderStructuredOutput,
  input: ControllerInput<HelarcAgentOutput>,
): ControllerModelItem {
  return Object.freeze({
    id: `${input.runId}:model:${input.iteration}`,
    kind: "assistant_action",
    content: output,
    metadata: Object.freeze(createControllerTraceMetadata(output, input)),
  });
}

function normalizeProviderOutput(output: unknown): unknown {
  if (typeof output !== "string") {
    return output;
  }
  if (output.length > HELARC_CONTROLLER_OUTPUT_MAX_LENGTH) {
    throw new HelarcControllerParseError("controller_output_too_large");
  }

  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new HelarcControllerParseError("controller_output_not_json");
  }
}

function assertToolNameSupported(
  toolName: string,
  input: ControllerInput<HelarcAgentOutput>,
): void {
  if (input.toolExposure.catalog.tools.some((tool) => tool.name === toolName)) {
    return;
  }

  throw new HelarcControllerParseError("controller_tool_name_unsupported");
}

function createControllerTraceMetadata(
  output: HelarcProviderStructuredOutput,
  input: ControllerInput<HelarcAgentOutput>,
): Readonly<Record<string, unknown>> {
  const metadata: Record<string, unknown> = {
    source: "helarc-controller",
    controllerAction: output.kind,
    promptArchitectureVersion: HELARC_PROMPT_ARCHITECTURE_VERSION,
    actionContractVersion: HELARC_ACTION_CONTRACT_VERSION,
    toolExposureVersion: HELARC_TOOL_EXPOSURE_VERSION,
    toolSelectionRevision: input.toolExposure.selectionRevision,
    toolExposureContentRevision: input.toolExposure.contentRevision,
    toolExposureBasisRevision: input.toolExposure.basisRevision,
    toolExposureProofId: input.toolExposure.id,
    exposedToolCount: input.toolExposure.exposedTools.length,
    omittedToolCount: input.toolExposure.omittedToolCount,
    toolExposureOmissionReasons: input.toolExposure.omissionReasons,
    exposedToolNames: input.toolExposure.catalog.tools.map((tool) => tool.name),
    instructionBindingId: input.instructionBinding.ref.id,
    instructionBindingRevision: input.instructionBinding.ref.revision,
    instructionBindingEffectiveFromRunRevision:
      input.instructionBinding.effectiveFromRunRevision,
    instructionBindingSupersedesId: input.instructionBinding.supersedes?.id ?? null,
    instructionBindingSupersedesRevision:
      input.instructionBinding.supersedes?.revision ?? null,
    agentId: input.agent.id,
    agentRevision: input.agent.revision,
    agentInstructionsId: input.agent.instructions.ref.id,
    agentInstructionsRevision: input.agent.instructions.ref.revision,
    agentInstructionReleaseId: input.agent.instructions.release.id,
    agentInstructionReleaseRevision: input.agent.instructions.release.revision,
    agentInstructionResolverRevision: input.agent.instructions.resolverRevision,
    agentInstructionContentDigest: input.agent.instructions.contentDigest.value,
    agentInstructionBlockCount: input.agent.instructions.blocks.length,
    agentInstructionProviderId: input.agent.instructions.model.providerId,
    agentInstructionModelId: input.agent.instructions.model.modelId,
  };

  if (output.kind === "tool_call") {
    metadata.requestedToolName = output.toolName;
  }

  return Object.freeze(metadata);
}

function oneCandidate<T extends ProgressionCandidate>(candidate: T): readonly [T] {
  return Object.freeze([candidate]) as readonly [T];
}
