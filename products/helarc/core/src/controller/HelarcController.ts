import {
  ControllerError,
  createControllerModelItems,
  type ControllerDecision,
  type ControllerInput,
  type ProgressionCandidate,
  type ProviderRequestBuildContext,
} from "@agent-anything/agent-runtime/controller";
import {
  composeModelInput,
  modelMessagesFromComposition,
} from "@agent-anything/model-interaction/input";
import {
  createNativeToolTurnInteraction,
  type ModelToolCall,
  type ProviderRequest,
  type ProviderResponse,
} from "@agent-anything/model-interaction";

import {
  buildHelarcPromptAssembly,
  HELARC_MODEL_OUTPUT_RESERVE_BYTES,
  HELARC_PROMPT_ARCHITECTURE_VERSION,
  HELARC_TOOL_EXPOSURE_VERSION,
} from "../prompt/HelarcPromptAssembly.js";
import {
  createHelarcModelCallableCatalog,
  findHelarcModelCallableBinding,
  HELARC_STOP_REASON_MAX_LENGTH,
} from "./HelarcModelCallableCatalog.js";

export const HELARC_CONTROLLER_CAPABILITY = "helarc.code-agent.turn";
export const HELARC_NATIVE_TOOL_PROTOCOL_REVISION =
  "helarc.provider-native-tool-interaction.v1";
export type HelarcAgentOutput = { kind: "complete"; summary: string };

class HelarcInstructionModelMismatchError extends TypeError {
  readonly code = "agent_instruction_model_mismatch";

  constructor() {
    super("Active Agent instructions, instruction binding, and Provider model must match.");
    this.name = "HelarcInstructionModelMismatchError";
  }
}

export function buildHelarcProviderRequest(
  input: ControllerInput<HelarcAgentOutput>,
  context: ProviderRequestBuildContext,
): ProviderRequest {
  assertInstructionModelIdentity(input, context);
  if (context.correction !== null) {
    throw new TypeError("Native Helarc Tool turns do not accept structured-output correction.");
  }
  if (input.interaction.unsettledCalls.length > 0) {
    throw new TypeError("Helarc cannot request another Model Turn while a model call is unsettled.");
  }
  const callableCatalog = createHelarcModelCallableCatalog({
    toolExposure: input.toolExposure,
    planLimits: input.planLimits,
  });
  const interaction = createNativeToolTurnInteraction(callableCatalog.definitions);
  const promptAssembly = buildHelarcPromptAssembly({ controllerInput: input });
  const composition = composeModelInput({
    id: `${input.runId}:model-input:${input.iteration}:${context.attemptNumber}`,
    providerId: context.inputAccounting.providerId,
    model: context.inputAccounting.model,
    accounting: context.inputAccounting,
    interaction,
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
      instructionBinding: source("agent-runtime", "agent_instruction_binding", input.instructionBinding.ref.id, input.instructionBinding.ref.revision),
      agent: source("agent-core", "agent_revision", input.agent.id, input.agent.revision),
      instructions: source("agent-core", "agent_instructions", input.agent.instructions.ref.id, input.agent.instructions.ref.revision),
      instructionRelease: source("helarc", "agent_instruction_release", input.agent.instructions.release.id, input.agent.instructions.release.revision),
      instructionResolver: source("helarc", "agent_instruction_resolver", `${input.agent.instructions.release.id}:resolver`, input.agent.instructions.resolverRevision),
      instructionContent: source("agent-core", "agent_instruction_content_digest", input.agent.instructions.ref.id, `sha256:${input.agent.instructions.contentDigest.value}`),
      instructionModel: Object.freeze({
        providerId: input.agent.instructions.model.providerId,
        model: input.agent.instructions.model.modelId,
      }),
      instructionBlocks: Object.freeze(input.agent.instructions.blocks.map((block) =>
        source(block.source.owner, block.source.kind, block.source.id, block.source.revision)
      )),
      activeContext: source("context", "active_context", input.context.activeContext.id, String(input.context.activeContext.version)),
      contextProjection: source("context", "context_projection", input.context.id, String(input.context.activeContext.version)),
      projectionManifest: source("context", "projection_manifest", input.contextManifest.id, String(input.contextManifest.activeContext.version)),
      toolSelection: source("tools", "tool_selection", input.toolExposure.selectionRevision, input.toolExposure.selectionRevision),
      toolExposureContent: source("tools", "tool_exposure_content", input.toolExposure.contentRevision, input.toolExposure.contentRevision),
      toolExposureBasis: source("tools", "tool_exposure_basis", input.toolExposure.basisRevision, input.toolExposure.basisRevision),
      toolExposureProof: source("tools", "tool_exposure_proof", input.toolExposure.id, input.toolExposure.id),
      controllerControlSet: source("helarc", "controller_control_set", callableCatalog.controlSetRevision, callableCatalog.controlSetRevision),
      interactionHistory: input.interaction.messages.length === 0
        ? null
        : source("agent-runtime", "model_interaction_projection", input.interaction.id, input.interaction.revision),
      protocol: source("helarc", "provider_native_tool_interaction", HELARC_NATIVE_TOOL_PROTOCOL_REVISION, HELARC_NATIVE_TOOL_PROTOCOL_REVISION),
      policy: source("context", "projection_policy", input.contextManifest.policy.id, input.contextManifest.policy.revision),
    }),
    composedAt: input.context.createdAt,
  });

  return {
    requestId: composition.id,
    purpose: HELARC_CONTROLLER_CAPABILITY,
    correlation: {
      controllerRequestId: input.toolExposure.controllerRequestId,
      branchId: `${input.runId}:main`,
    },
    interaction,
    metadata: {
      runId: input.runId,
      controllerIteration: input.iteration,
      taskId: input.task.id,
      taskKind: input.task.kind,
      promptArchitectureVersion: promptAssembly.versions.promptArchitectureVersion,
      toolExposureVersion: promptAssembly.versions.toolExposureVersion,
      toolSelectionRevision: input.toolExposure.selectionRevision,
      toolExposureContentRevision: input.toolExposure.contentRevision,
      toolExposureBasisRevision: input.toolExposure.basisRevision,
      toolExposureProofId: input.toolExposure.id,
      exposedToolCount: input.toolExposure.exposedTools.length,
      omittedToolCount: input.toolExposure.omittedToolCount,
      modelCallableCatalogRevision: callableCatalog.revision,
      controllerControlSetRevision: callableCatalog.controlSetRevision,
      interactionProjectionId: input.interaction.id,
      interactionProjectionRevision: input.interaction.revision,
      interactionMessageCount: input.interaction.messages.length,
      instructionBindingId: input.instructionBinding.ref.id,
      instructionBindingRevision: input.instructionBinding.ref.revision,
      agentId: input.agent.id,
      agentRevision: input.agent.revision,
      modelInputCompositionId: composition.id,
      contextProjectionId: input.context.id,
      contextManifestId: input.contextManifest.id,
    },
    messages: modelMessagesFromComposition(composition),
    composition,
    continuation: null,
  };
}

export function parseHelarcProviderResponse(
  response: ProviderResponse,
  input: ControllerInput<HelarcAgentOutput>,
): ControllerDecision<HelarcAgentOutput> {
  if (response.kind !== "native_tool_turn") {
    return nativeTurnFailure("helarc_native_response_kind_invalid");
  }
  const catalog = createHelarcModelCallableCatalog({
    toolExposure: input.toolExposure,
    planLimits: input.planLimits,
  });
  assertTurnCorrelation(response, input);
  const modelItems = createControllerModelItems(
    response.turn,
    createControllerTraceMetadata(response, input, catalog.revision),
  );
  const calls = response.turn.assistant.content.flatMap((block) =>
    block.kind === "model_tool_call" ? [block.call] : []
  );
  const text = response.turn.assistant.content.flatMap((block) =>
    block.kind === "text" && block.text.trim().length > 0 ? [block.text.trim()] : []
  ).join("\n");

  if (response.turn.finish.kind === "refusal") {
    if (calls.length > 0) return nativeTurnFailure("helarc_refusal_with_calls");
    return Object.freeze({
      kind: "propose_stop",
      reason: boundedStopReason(response.turn.finish.reason ?? text),
      modelItems,
    });
  }
  if (response.turn.finish.kind !== "normal") {
    return nativeTurnFailure(`helarc_model_finish_${response.turn.finish.kind}`);
  }
  if (calls.length === 0) {
    if (text.length === 0) return nativeTurnFailure("helarc_native_turn_empty");
    return Object.freeze({
      kind: "propose_completion",
      output: Object.freeze({ kind: "complete", summary: text }),
      modelItems,
    });
  }

  if (calls.length === 1) {
    const binding = findHelarcModelCallableBinding(catalog, calls[0]!.name);
    if (binding?.kind === "control" && binding.control === "stop") {
      const reason = readStopReason(calls[0]!);
      if (reason !== null) {
        return Object.freeze({ kind: "propose_stop", reason, modelItems });
      }
    }
  }

  const candidates = calls.map((call) => bindModelCall(call, calls.length, catalog, input));
  return Object.freeze({
    kind: "advance",
    candidates: Object.freeze(candidates) as readonly [
      ProgressionCandidate,
      ...ProgressionCandidate[],
    ],
    modelItems,
  });
}

function bindModelCall(
  call: ModelToolCall,
  callCount: number,
  catalog: ReturnType<typeof createHelarcModelCallableCatalog>,
  input: ControllerInput<HelarcAgentOutput>,
): ProgressionCandidate {
  const binding = findHelarcModelCallableBinding(catalog, call.name);
  if (binding === undefined) {
    return rejectedCall(call, "model_callable_unknown", "The requested callable is not in the active catalog.");
  }
  if (binding.kind === "tool") {
    return Object.freeze({
      kind: "tool_request",
      tool: Object.freeze({
        name: binding.toolName,
        revision: binding.tool.revision,
        input: call.input,
        origin: "model",
        controllerRequestId: input.toolExposure.controllerRequestId,
      }),
      modelCallRef: call.modelCallRef,
    });
  }
  if (binding.control === "update_plan") {
    return Object.freeze({
      kind: "state_transition",
      transition: "plan_update",
      input: call.input,
      modelCallRef: call.modelCallRef,
    });
  }
  return rejectedCall(
    call,
    callCount === 1 ? "stop_input_invalid" : "stop_must_be_sole_call",
    callCount === 1
      ? "The stop control requires one bounded non-empty reason."
      : "The stop control must be the only call in its Model Turn.",
  );
}

function rejectedCall(call: ModelToolCall, code: string, message: string): ProgressionCandidate {
  return Object.freeze({
    kind: "model_call_rejection",
    name: call.name,
    code,
    message,
    modelCallRef: call.modelCallRef,
  });
}

function readStopReason(call: ModelToolCall): string | null {
  return typeof call.input.reason === "string" &&
      call.input.reason.trim().length > 0 &&
      call.input.reason.trim().length <= HELARC_STOP_REASON_MAX_LENGTH
    ? call.input.reason.trim()
    : null;
}

function boundedStopReason(reason: string | null): string {
  const normalized = reason?.trim() ?? "";
  return normalized.length === 0
    ? "Model refused the request."
    : normalized.slice(0, HELARC_STOP_REASON_MAX_LENGTH);
}

function assertTurnCorrelation(
  response: Extract<ProviderResponse, { readonly kind: "native_tool_turn" }>,
  input: ControllerInput<HelarcAgentOutput>,
): void {
  const expectedRequestId = `${input.runId}:model-input:${input.iteration}:1`;
  if (response.turn.responseRef.requestId !== expectedRequestId) {
    return nativeTurnFailure("helarc_model_response_request_mismatch");
  }
  for (const block of response.turn.assistant.content) {
    if (
      block.kind === "model_tool_call" &&
      (
        block.call.modelCallRef.controllerRequestId !== input.toolExposure.controllerRequestId ||
        block.call.modelCallRef.branchId !== `${input.runId}:main`
      )
    ) return nativeTurnFailure("helarc_model_call_correlation_mismatch");
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
  ) throw new HelarcInstructionModelMismatchError();
}

function createControllerTraceMetadata(
  response: Extract<ProviderResponse, { readonly kind: "native_tool_turn" }>,
  input: ControllerInput<HelarcAgentOutput>,
  callableCatalogRevision: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    source: "helarc-controller",
    controllerProtocol: "provider_native_tool_interaction",
    promptArchitectureVersion: HELARC_PROMPT_ARCHITECTURE_VERSION,
    toolExposureVersion: HELARC_TOOL_EXPOSURE_VERSION,
    toolSelectionRevision: input.toolExposure.selectionRevision,
    toolExposureContentRevision: input.toolExposure.contentRevision,
    toolExposureBasisRevision: input.toolExposure.basisRevision,
    toolExposureProofId: input.toolExposure.id,
    modelCallableCatalogRevision: callableCatalogRevision,
    modelTurnId: response.turn.turnId,
    modelFinishKind: response.turn.finish.kind,
    modelResponseId: response.turn.responseRef.responseId,
    agentId: input.agent.id,
    agentRevision: input.agent.revision,
    instructionBindingId: input.instructionBinding.ref.id,
    instructionBindingRevision: input.instructionBinding.ref.revision,
  });
}

function source(owner: string, kind: string, id: string, revision: string) {
  return Object.freeze({ owner, kind, id, revision });
}

function nativeTurnFailure(code: string): never {
  throw new ControllerError(Object.freeze({
    kind: "model",
    failure: Object.freeze({
      code: "model_output_invalid",
      message: "The Provider returned a Model Turn that Helarc could not safely admit.",
      retryable: false,
      metadata: Object.freeze({ helarcCode: code }),
    }),
  }));
}
