import type {
  ControllerInput,
  ControllerPreProjectionInput,
} from "@agent-anything/agent-runtime/controller";
import type {
  ContextProjection,
  ContextProjectionEstimationInput,
} from "@agent-anything/context/projection";
import type { ModelInputSectionCandidate } from "@agent-anything/model-interaction/input";
import { createHash } from "node:crypto";
import {
  HELARC_DEFAULT_PROTOCOL_INSTRUCTIONS,
  type HelarcInstructionSectionSetting,
} from "../instructions/HelarcProtocolInstructions.js";
import type { HelarcTaskInput } from "../task/HelarcTaskInput.js";
import {
  buildHelarcVerificationText,
  isHelarcVerificationContextBlock,
} from "../verification/HelarcVerificationPrompt.js";

export const HELARC_PROMPT_ARCHITECTURE_VERSION = "helarc-prompt-v7";
export const HELARC_TOOL_EXPOSURE_VERSION = "trusted-tool-exposure-v1";
export const HELARC_CONTEXT_PROJECTION_FORMAT_VERSION = "helarc-context-projection-v2";
export const HELARC_CONTEXT_SECTION_HEADER = "Context projection:";

export type HelarcPromptSectionId =
  | "native_tool_protocol"
  | "permission_safety"
  | "stop_protocol"
  | "safe_output_boundary"
  | "task"
  | "run_input_items"
  | "context_projection"
  | "current_plan"
  | "current_verification"
  | "permission_context"
  | "pending_interactions"
  | "descendant_targets";

export interface HelarcPromptSection {
  readonly id: string;
  readonly source: ModelInputSectionCandidate["source"];
  readonly kind: "agent_instruction" | "product_protocol" | "run_material";
  readonly role: ModelInputSectionCandidate["role"];
  readonly necessity: ModelInputSectionCandidate["necessity"];
  readonly content: string;
}

export interface HelarcPromptAssemblyVersions {
  promptArchitectureVersion: typeof HELARC_PROMPT_ARCHITECTURE_VERSION;
  toolExposureVersion: typeof HELARC_TOOL_EXPOSURE_VERSION;
  contextProjectionFormatVersion: typeof HELARC_CONTEXT_PROJECTION_FORMAT_VERSION;
}

export interface HelarcPromptAssemblyResult {
  readonly sections: readonly ModelInputSectionCandidate[];
  readonly promptSections: readonly HelarcPromptSection[];
  readonly exposedToolNames: readonly string[];
  readonly versions: HelarcPromptAssemblyVersions;
}

export function buildHelarcBasePromptAssembly(
  input: ControllerPreProjectionInput,
  protocolInstructions: readonly HelarcInstructionSectionSetting[] = HELARC_DEFAULT_PROTOCOL_INSTRUCTIONS,
): HelarcPromptAssemblyResult {
  return assemble(input, HELARC_CONTEXT_SECTION_HEADER, null, protocolInstructions);
}

export function buildHelarcPromptAssembly(input: {
  readonly controllerInput: ControllerInput;
  readonly protocolInstructions?: readonly HelarcInstructionSectionSetting[];
}): HelarcPromptAssemblyResult {
  return assemble(
    input.controllerInput,
    renderHelarcContextProjection(input.controllerInput.context),
    input.controllerInput.context,
    input.protocolInstructions ?? HELARC_DEFAULT_PROTOCOL_INSTRUCTIONS,
  );
}

export function renderHelarcContextProjectionFragment(
  input: ContextProjectionEstimationInput,
): string {
  return `\n${JSON.stringify({
    contribution: input.contribution,
    instructionRole: input.instructionRole,
    payload: input.payload,
  })}`;
}

function assemble(
  input: ControllerPreProjectionInput | ControllerInput,
  contextContent: string,
  context: ContextProjection | null,
  protocolInstructions: readonly HelarcInstructionSectionSetting[],
): HelarcPromptAssemblyResult {
  const exposedToolNames = Object.freeze(input.toolExposure.catalog.tools.map((tool) => tool.name));
  const promptSections = Object.freeze([
    ...buildAgentInstructionSections(input),
    ...buildSystemPromptSections(protocolInstructions),
    promptSection("task", "user", `Task:\n${readHelarcTaskPrompt(input)}`),
    promptSection("run_input_items", "user", `Run input items:\n${JSON.stringify(input.inputItems)}`),
  ]);
  const currentStateSections = Object.freeze([
    promptSection("context_projection", "user", contextContent),
    promptSection("current_plan", "user", `Current plan:\n${JSON.stringify(input.plan)}`),
    promptSection("current_verification", "user", buildHelarcVerificationText({
      context,
      toolExposure: input.toolExposure,
      verification: input.verification,
    })),
    promptSection("permission_context", "user", `Permission context:\n${JSON.stringify(input.permission)}`),
    promptSection("pending_interactions", "user", `Pending interactions:\n${JSON.stringify(input.pending)}`),
    promptSection("descendant_targets", "user", `Descendant targets:\n${JSON.stringify(input.descendants)}`),
  ]);
  const allPromptSections = Object.freeze([...promptSections, ...currentStateSections]);
  const sections = Object.freeze([
    ...promptSections.map((section) => toModelInputSection(section, context)),
    ...interactionHistorySections(input),
    ...currentStateSections.map((section) => toModelInputSection(section, context)),
  ]);
  return Object.freeze({
    sections,
    promptSections: allPromptSections,
    exposedToolNames,
    versions: Object.freeze({
      promptArchitectureVersion: HELARC_PROMPT_ARCHITECTURE_VERSION,
      toolExposureVersion: HELARC_TOOL_EXPOSURE_VERSION,
      contextProjectionFormatVersion: HELARC_CONTEXT_PROJECTION_FORMAT_VERSION,
    }),
  });
}

function buildSystemPromptSections(
  entries: readonly HelarcInstructionSectionSetting[],
): readonly HelarcPromptSection[] {
  return Object.freeze(entries
    .filter(({ enabled, content }) => enabled && content.trim().length > 0)
    .map(({ id, content }) => {
      const revision = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
      return Object.freeze({
        id,
        source: Object.freeze({ owner: "helarc", kind: "product_protocol", id: `helarc.protocol-instructions.${id}`, revision }),
        kind: "product_protocol" as const,
        role: "instruction" as const,
        necessity: "mandatory" as const,
        content,
      });
    }));
}

function interactionHistorySections(
  input: ControllerPreProjectionInput | ControllerInput,
): readonly ModelInputSectionCandidate[] {
  if (!("interaction" in input)) return Object.freeze([]);
  return Object.freeze(input.interaction.messages.map((message, index) => Object.freeze({
    id: `helarc:model-input:interaction-history:${index}`,
    source: Object.freeze({
      owner: "agent-runtime",
      kind: "model_interaction_projection",
      id: input.interaction.id,
      revision: input.interaction.revision,
    }),
    kind: "interaction_history",
    role: message.role,
    necessity: "mandatory",
    content: Object.freeze({ kind: "model_message", message }),
  })));
}

function buildAgentInstructionSections(
  input: ControllerPreProjectionInput | ControllerInput,
): readonly HelarcPromptSection[] {
  return Object.freeze(input.agent.instructions.blocks.map((block) => Object.freeze({
    id: `agent-instructions:${block.id}`,
    source: Object.freeze({
      owner: block.source.owner,
      kind: block.source.kind,
      id: block.source.id,
      revision: block.source.revision,
    }),
    kind: "agent_instruction" as const,
    role: "instruction" as const,
    necessity: "mandatory" as const,
    content: block.content,
  })));
}

function promptSection(
  id: HelarcPromptSectionId,
  role: ModelInputSectionCandidate["role"],
  content: string,
): HelarcPromptSection {
  return Object.freeze({
    id,
    source: Object.freeze({
      owner: "helarc",
      kind: "prompt_section",
      id,
      revision: HELARC_PROMPT_ARCHITECTURE_VERSION,
    }),
    kind: role === "instruction" ? "product_protocol" as const : "run_material" as const,
    role,
    necessity: "mandatory" as const,
    content,
  });
}

function toModelInputSection(
  section: HelarcPromptSection,
  context: ContextProjection | null,
): ModelInputSectionCandidate {
  const isContext = section.id === "context_projection" || section.id === "current_verification";
  return Object.freeze({
    id: `helarc:model-input:${section.id}`,
    source: isContext && context !== null
      ? Object.freeze({
          owner: "context",
          kind: "context_projection",
          id: context.id,
          revision: String(context.activeContext.version),
        })
      : section.source,
    kind: isContext ? "context_projection" : section.kind,
    role: section.role,
    necessity: section.necessity,
    content: Object.freeze({ kind: "text" as const, text: section.content }),
  });
}

function renderHelarcContextProjection(context: ContextProjection): string {
  return HELARC_CONTEXT_SECTION_HEADER + context.blocks
    .filter((block) => !isHelarcVerificationContextBlock(block))
    .map((block) =>
    renderHelarcContextProjectionFragment({
      item: block.item,
      contribution: block.contribution,
      instructionRole: block.instructionRole,
      payload: block.payload,
      transformation: block.transformation,
    })
  ).join("");
}

function readHelarcTaskPrompt(
  input: ControllerPreProjectionInput | ControllerInput,
): string {
  const taskInput = input.task.input as Partial<HelarcTaskInput>;
  return typeof taskInput.prompt === "string" ? taskInput.prompt : "";
}
