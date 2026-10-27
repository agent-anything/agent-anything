import {
  TaskDecisionActivityError,
  createControllerModelItems,
  createModelOutputRecoverySection,
  type TaskDecisionProposal,
  type TaskDecisionInputSources,
  type ProgressionCandidate,
  type ProviderRequestBuildContext,
} from "@agent-anything/agent-runtime/decision";
import { ExecutionFlowPath, type ExecutionFlowContext } from "@agent-anything/observability/execution-flow";
import { HELARC_REQUEST_EXECUTION_FLOW, HELARC_RESPONSE_EXECUTION_FLOW } from "./HelarcControllerExecutionFlow.js";
import {
  composeModelInput,
  modelInputFromComposition,
} from "@agent-anything/model-interaction/input";
import {
  createNativeToolTurnInteraction,
  type ModelCallableRequest,
  type ProviderRequest,
  type ProviderResponse,
} from "@agent-anything/model-interaction";

import {
  buildHelarcPromptAssembly,
  HELARC_PROMPT_ARCHITECTURE_VERSION,
  HELARC_TOOL_EXPOSURE_VERSION,
} from "../prompt/HelarcPromptAssembly.js";
import {
  findHelarcModelCallableBinding,
  type HelarcModelCallableCatalog,
} from "./HelarcModelCallableCatalog.js";
import type { HelarcControllerProtocolComposition } from "./HelarcControllerProtocolComposition.js";
import { helarcOpeningBackground, type HelarcExecutionBackground } from "../prompt/HelarcConversationOpening.js";
import { createHelarcUnknownCallableRejection } from "./HelarcModelCallFeedback.js";
import { finalResultInputError } from "./HelarcFinalResultInput.js";

import { resolveHelarcFinalReply, createHelarcEndingSignalFeedback, type HelarcFinalReplyResolution } from "./HelarcFinalReply.js";
import {snapshotContextMaterialRefs, type ContextMaterialRef} from "@agent-anything/context/material";

export const HELARC_CONTROLLER_CAPABILITY = "helarc.code-agent.turn";
export const HELARC_NATIVE_TOOL_PROTOCOL_REVISION =
  "helarc.provider-native-tool-interaction.v4";
export const HELARC_MODEL_CONTEXT_HEADROOM_TOKENS = 1_024;
export type HelarcAgentOutput = { kind: "complete"; summary: string; source: import("../run/presentation/HelarcRunPresentation.js").HelarcOutputSource; finalReply?: HelarcFinalReplyResolution; materialRefs?: readonly ContextMaterialRef[] };

class HelarcInstructionModelMismatchError extends TypeError {
  readonly code = "agent_instruction_model_mismatch";

  constructor() {
    super("Active Agent instructions, instruction binding, and Provider model must match.");
    this.name = "HelarcInstructionModelMismatchError";
  }
}

export function buildHelarcProviderRequest(
  input: TaskDecisionInputSources<HelarcAgentOutput>,
  context: ProviderRequestBuildContext,
  protocol: HelarcControllerProtocolComposition,
  executionBackground?: HelarcExecutionBackground,
): ProviderRequest {
  const flow = new ExecutionFlowPath(HELARC_REQUEST_EXECUTION_FLOW, context.executionFlow ?? {}, input.runId);
  try {
    const step = flow.advance("compose", {agentId:input.agent.id, instructionBlocks:input.agent.instructions.blocks.length, unsettledCalls:input.interaction.unsettledCalls.length},
      [{owner: "runtime", kind: "request", id: input.toolExposure.controllerRequestId, revision: null}]);
    if (!input.interaction.opening) {
      const background = helarcOpeningBackground(input, executionBackground);
      flow.material("Bound execution background", "bound", background.value, "agent", background.source);
    }
    const request = buildRequest(input, context, protocol, executionBackground);
    step.check("instruction_binding", "passed", {bindingId:input.instructionBinding.ref.id});
    step.check("settled_interaction", "passed");
    const compositionRef = flow.material("Model input composition", "composed", request.composition, "provider");
    step.output(compositionRef);
    flow.advance("request", {compositionId:request.composition.id, workingViewId:request.composition.workingView.id,
      selectedOccurrenceCount:request.composition.workingView.entries.length,
      nativeExchangeGroupCount:request.composition.workingView.nativeGroups.length}, [compositionRef])
      .output({owner:"model-interaction",kind:"request",id:request.requestId,revision:null});
    flow.close("returned");
    return request;
  } catch (error) { flow.close("failed"); throw error; }
}

function buildRequest(
  input: TaskDecisionInputSources<HelarcAgentOutput>,
  context: ProviderRequestBuildContext,
  protocol: HelarcControllerProtocolComposition,
  executionBackground?: HelarcExecutionBackground,
): ProviderRequest {
  assertInstructionModelIdentity(input, context);
  if (context.correction !== null) {
    throw new TypeError("Native Helarc Tool turns do not accept structured-output correction.");
  }
  if (input.interaction.unsettledCalls.length > 0) {
    throw new TypeError("Helarc cannot request another Model Turn while a model call is unsettled.");
  }
  const callableCatalog = protocol.createCallableCatalog(
    input.toolExposure,
    input.planLimits,
    input.plan !== null,
  );
  const toolGuidanceBinding = protocol.bindRun(input.runId);
  const interaction = createNativeToolTurnInteraction(callableCatalog.definitions);
  const promptAssembly = buildHelarcPromptAssembly({
    controllerInput: input,
    protocolInstructions: protocol.protocolInstructions,
    executionBackground,
  });
  const recoverySection = createModelOutputRecoverySection(context.outputRecovery);
  const composition = composeModelInput({
    id: `${input.runId}:model-input:${input.iteration}:${context.attemptNumber}`,
    providerId: context.target.providerId,
    model: context.target.model,
    interaction,
    sections: [...promptAssembly.sections, ...(recoverySection ? [recoverySection] : [])],
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
      toolGuidance: source("helarc", "tool_guidance_binding", toolGuidanceBinding.id, toolGuidanceBinding.contentDigest),
      controllerControlGuidance: source("helarc", "controller_control_guidance", protocol.controlGuidance.id, protocol.controlGuidance.revision),
      callableDefinitions: source("helarc", "model_callable_definitions", callableCatalog.revision, callableCatalog.definitionsDigest),
      modelQualification: null,
      interactionHistory: input.interaction.messages.length === 0
        ? null
        : source("agent-runtime", "model_interaction_projection", input.interaction.id, input.interaction.revision),
      protocol: source("helarc", "provider_native_tool_interaction", HELARC_NATIVE_TOOL_PROTOCOL_REVISION, HELARC_NATIVE_TOOL_PROTOCOL_REVISION),
      policy: source("context", "projection_policy", input.contextManifest.policy.id, input.contextManifest.policy.revision),
    }),
    composedAt: input.context.createdAt,
  });

  const modelInput = modelInputFromComposition(composition);
  return {
    requestId: composition.id,
    purpose: HELARC_CONTROLLER_CAPABILITY,
    correlation: {
      controllerRequestId: input.toolExposure.controllerRequestId,
      branchId: `${input.runId}:main`,
    },
    interaction,
    modelContext: Object.freeze({
      requestedOutput: context.requestedOutput,
      headroom: Object.freeze({
        unit: "tokens" as const,
        amount: HELARC_MODEL_CONTEXT_HEADROOM_TOKENS,
        policy: Object.freeze({
          id: "helarc.model-context-headroom",
          revision: "1",
        }),
      }),
      assessment: null,
    }),
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
      modelCallableDefinitionsDigest: callableCatalog.definitionsDigest,
      toolGuidanceBindingId: toolGuidanceBinding.id,
      toolGuidanceReleaseId: toolGuidanceBinding.release.id,
      toolGuidanceReleaseRevision: toolGuidanceBinding.release.revision,
      toolGuidanceProfileRevision: toolGuidanceBinding.guidanceProfileRevision,
      toolGuidanceContentDigest: toolGuidanceBinding.contentDigest,
      controllerControlGuidanceRevision: callableCatalog.controlGuidanceRevision,
      interactionProjectionId: input.interaction.id,
      interactionProjectionRevision: input.interaction.revision,
      interactionMessageCount: input.interaction.messages.length,
      conversationOpeningSections: composition.sections.filter(section => section.kind.startsWith("conversation_opening")).length,
      conversationReplaySections: composition.sections.filter(section => section.provenance?.retainedPresentation !== undefined).length,
      conversationImportedSections: composition.sections.filter(section => section.provenance?.purpose === "imported_history").length,
      conversationNewNotifications: input.inputDelivery?.entries.length ?? 0,
      instructionBindingId: input.instructionBinding.ref.id,
      instructionBindingRevision: input.instructionBinding.ref.revision,
      agentId: input.agent.id,
      agentRevision: input.agent.revision,
      modelInputCompositionId: composition.id,
      contextProjectionId: input.context.id,
      contextManifestId: input.contextManifest.id,
    },
    instructions: modelInput.instructions,
    messages: modelInput.messages,
    composition,
    continuation: null,
  };
}

export function parseHelarcProviderResponse(
  response: ProviderResponse,
  input: TaskDecisionInputSources<HelarcAgentOutput>,
  protocol: HelarcControllerProtocolComposition,
  executionFlow?: ExecutionFlowContext,
  materialReferenceError: string | null = null,
): TaskDecisionProposal<HelarcAgentOutput> {
  const flow = new ExecutionFlowPath(HELARC_RESPONSE_EXECUTION_FLOW, executionFlow ?? {}, input.runId);
  const interpretation = flow.advance("interpret", {controllerRequestId:input.toolExposure.controllerRequestId, responseKind:response.kind},
    [flow.material("Response to interpret", "received", response, "provider")]);
  try {
    const decision = interpretResponse(response, input, protocol, materialReferenceError);
    const decisionRef = flow.material("Interpreted Controller decision", "interpreted", decision);
    interpretation.output(decisionRef);
    if (decision.kind === "propose_completion" && decision.output.finalReply) {
      const reply = decision.output.finalReply;
      const source = decision.output.source;
      flow.advance("reply_resolution", {disposition: reply.disposition, textJoin: reply.textJoin, interactionRevision: reply.interactionRevision}, [
        {owner: "runtime", kind: "call", id: reply.ending.call.id, revision: null},
        ...(source.kind === "model_text" ? source.modelItemIds.map(id => ({owner: "runtime", kind: "contribution", id, revision: null})) : []),
      ]).output(decisionRef, {owner: "helarc", kind: "contribution", id: `${reply.ending.call.id}:final-reply`, revision: reply.protocolRevision});
    }
    flow.advance("decision", {kind:decision.kind, candidates:"candidates" in decision ? decision.candidates.length : 0}, [decisionRef]).output(decisionRef);
    flow.close("returned");
    return decision;
  } catch (error) { flow.close("failed"); throw error; }
}

function interpretResponse(
  response: ProviderResponse,
  input: TaskDecisionInputSources<HelarcAgentOutput>,
  protocol: HelarcControllerProtocolComposition,
  materialReferenceError: string | null,
): TaskDecisionProposal<HelarcAgentOutput> {
  if (response.kind !== "native_tool_turn") {
    return nativeTurnFailure("helarc_native_response_kind_invalid");
  }
  const catalog = protocol.createCallableCatalog(input.toolExposure, input.planLimits, input.plan !== null);
  assertTurnCorrelation(response, input);
  const modelItems = createControllerModelItems(
    response.turn,
    createControllerTraceMetadata(response, input, catalog),
  ).map(item => item.kind === "model_tool_call" ? Object.freeze({
    ...item,
    metadata: Object.freeze({
      ...item.metadata,
      helarcCallableBinding: findHelarcModelCallableBinding(catalog, item.call.name) ?? null,
    }),
  }) : item);
  const calls = response.turn.assistant.content.flatMap((block) =>
    block.kind === "model_tool_call" ? [block.call] : []
  );
  const text = response.turn.assistant.content.flatMap((block) =>
    block.kind === "text" && block.text.trim().length > 0 ? [block.text.trim()] : []
  ).join("\n");

  if (response.turn.finish.kind === "refusal") {
    if (calls.length > 0) return nativeTurnFailure("helarc_refusal_with_calls");
    return Object.freeze({
      kind: "propose_completion",
      candidates: [],
      completionSource: {kind: "controller" as const},
      output: Object.freeze({ kind: "complete", summary: response.turn.finish.reason ?? text,
        source: response.turn.finish.reason !== null
          ? { kind: "model_finish" as const, turnId: response.turn.turnId }
          : { kind: "model_text" as const, turnId: response.turn.turnId, modelItemIds: modelItems.filter(item => item.kind === "assistant_text").map(item => item.id) } }),
      modelItems,
    });
  }
  if (response.turn.finish.kind !== "normal") {
    return nativeTurnFailure(`helarc_model_finish_${response.turn.finish.kind}`);
  }
  if (calls.length === 0) {
    return Object.freeze({
      kind: "continue_with_feedback",
      feedback: {source: {owner: "helarc", kind: "controller_protocol", id: HELARC_NATIVE_TOOL_PROTOCOL_REVISION, revision: "4"},
        code: "helarc_ending_signal_missing",
        message: createHelarcEndingSignalFeedback({hasText: text.length > 0, hasPlan: input.plan !== null})},
      modelItems,
    });
  }

  const finals = calls.filter(call => {
    const binding = findHelarcModelCallableBinding(catalog, call.name);
    return binding?.kind === "control" && binding.control === "final_result";
  });
  const hasSeparatePlan = calls.some(call => {
    const binding = findHelarcModelCallableBinding(catalog, call.name);
    return binding?.kind === "control" && binding.control === "update_plan";
  });
  const finalError = finals.length > 1
    ? "Submit exactly one final_result call per turn."
    : hasSeparatePlan
      ? "Do not submit update_plan alongside final_result; include the complete final snapshot in final_result.plan instead."
      : finals.length === 1 ? finalResultInputError(finals[0]!.input, input.plan !== null, input.planLimits) ?? materialReferenceError : null;
  const final = finals.length === 1 && finalError === null
    ? finals[0]! : null;
  const candidates = calls.flatMap<ProgressionCandidate>(call => {
    if (call === final) {
      return Array.isArray(final.input.plan) && final.input.plan.length > 0 ? [{
        kind: "state_transition", transition: "plan_update",
        input: {plan: final.input.plan}, modelCallRef: final.modelCallRef,
      }] : [];
    }
    if (finals.includes(call)) {
      return [Object.freeze({
        kind: "model_call_rejection", name: call.name,
        code: finals.length > 1 ? "helarc_final_result_ambiguous" : "helarc_final_result_invalid",
        message: `${finalError} Other calls retain their own results; do not repeat successful calls merely to correct this call.`,
        modelCallRef: call.modelCallRef,
      })];
    }
    return [bindModelCall(call, catalog, input)];
  });
  if (final !== null) {
    const reply = resolveHelarcFinalReply({runId: input.runId, interactionRevision: input.interaction.revision,
      call: final, modelItems, previous: input.interaction.latestTurn});
    return Object.freeze({
      kind: "propose_completion",
      candidates: Object.freeze(candidates),
      completionSource: {kind: "model_call" as const, modelCallRef: final.modelCallRef},
      output: Object.freeze({kind: "complete" as const, ...reply, ...(final.input.material_refs !== undefined
        ? {materialRefs: snapshotContextMaterialRefs(final.input.material_refs)} : {})}),
      modelItems,
    });
  }
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
  call: ModelCallableRequest,
  catalog: HelarcModelCallableCatalog,
  input: TaskDecisionInputSources<HelarcAgentOutput>,
): ProgressionCandidate {
  const binding = findHelarcModelCallableBinding(catalog, call.name);
  if (binding === undefined) {
    return createHelarcUnknownCallableRejection(call, catalog);
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
  if (binding.control !== "update_plan") throw new TypeError("Output control must be interpreted before candidate binding.");
  return Object.freeze({
      kind: "state_transition",
      transition: "plan_update",
      input: call.input,
      modelCallRef: call.modelCallRef,
  });
}

function assertTurnCorrelation(
  response: Extract<ProviderResponse, { readonly kind: "native_tool_turn" }>,
  input: TaskDecisionInputSources<HelarcAgentOutput>,
): void {
  // The model task coordinator checks the actual request ID, including recovery attempts.
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
  input: TaskDecisionInputSources<HelarcAgentOutput>,
  context: ProviderRequestBuildContext,
): void {
  const model = input.agent.instructions.model;
  if (
    input.instructionBinding.model.providerId !== model.providerId ||
    input.instructionBinding.model.modelId !== model.modelId ||
    context.target.providerId !== model.providerId ||
    context.target.model !== model.modelId
  ) throw new HelarcInstructionModelMismatchError();
}

function createControllerTraceMetadata(
  response: Extract<ProviderResponse, { readonly kind: "native_tool_turn" }>,
  input: TaskDecisionInputSources<HelarcAgentOutput>,
  callableCatalog: HelarcModelCallableCatalog,
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
    modelCallableCatalogRevision: callableCatalog.revision,
    modelCallableDefinitionsDigest: callableCatalog.definitionsDigest,
    toolGuidanceId: callableCatalog.toolGuidanceId,
    toolGuidanceContentDigest: callableCatalog.toolGuidanceContentDigest,
    controllerControlGuidanceRevision: callableCatalog.controlGuidanceRevision,
    modelTurnId: response.turn.turnId,
    modelFinishKind: response.turn.finish.kind,
    modelResponseId: response.turn.responseRef.responseId,
    modelContextAssessmentId: response.metadata.modelContextAssessmentId ?? null,
    modelContextDisposition: response.metadata.modelContextDisposition ?? null,
    inputPreservationRevision: response.metadata.inputPreservationRevision ?? null,
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
  throw new TaskDecisionActivityError(Object.freeze({
    kind: "model",
    failure: Object.freeze({
      code: "model_output_invalid",
      message: "The Provider returned a Model Turn that Helarc could not safely admit.",
      retryable: false,
      metadata: Object.freeze({ helarcCode: code }),
    }),
  }));
}
