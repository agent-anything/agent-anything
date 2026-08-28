import type {
  ControllerInput,
  ControllerPreProjectionInput,
} from "@agent-anything/agent-runtime/controller";
import type {
  ContextProjection,
  ContextProjectionEstimationInput,
} from "@agent-anything/context/projection";
import type { ModelInputSectionCandidate } from "@agent-anything/model-interaction/input";
import type { HelarcTaskInput } from "../task/HelarcTaskInput.js";
import {
  buildHelarcVerificationText,
  isHelarcVerificationContextBlock,
} from "../verification/HelarcVerificationPrompt.js";

export const HELARC_PROMPT_ARCHITECTURE_VERSION = "helarc-prompt-v6";
export const HELARC_TOOL_EXPOSURE_VERSION = "trusted-tool-exposure-v1";
export const HELARC_CONTEXT_PROJECTION_FORMAT_VERSION = "helarc-context-projection-v2";
export const HELARC_CONTEXT_SECTION_HEADER = "Context projection:";
export const HELARC_MODEL_OUTPUT_RESERVE_BYTES = 256_000;

export type HelarcPromptSectionId =
  | "native_tool_protocol"
  | "permission_safety"
  | "stop_protocol"
  | "safe_output_boundary"
  | "task"
  | "run_input_items"
  | "context_projection"
  | "current_plan"
  | "current_progress"
  | "current_verification"
  | "permission_context"
  | "pending_interactions";

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
): HelarcPromptAssemblyResult {
  return assemble(input, HELARC_CONTEXT_SECTION_HEADER, null);
}

export function buildHelarcPromptAssembly(input: {
  readonly controllerInput: ControllerInput;
}): HelarcPromptAssemblyResult {
  return assemble(
    input.controllerInput,
    renderHelarcContextProjection(input.controllerInput.context),
    input.controllerInput.context,
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
): HelarcPromptAssemblyResult {
  const exposedToolNames = Object.freeze(input.toolExposure.catalog.tools.map((tool) => tool.name));
  const promptSections = Object.freeze([
    ...buildAgentInstructionSections(input),
    ...buildSystemPromptSections(input.toolExposure),
    promptSection("task", "user", `Task:\n${readHelarcTaskPrompt(input)}`),
    promptSection("run_input_items", "user", `Run input items:\n${JSON.stringify(input.inputItems)}`),
  ]);
  const currentStateSections = Object.freeze([
    promptSection("context_projection", "user", contextContent),
    promptSection("current_plan", "user", `Current plan:\n${JSON.stringify(input.plan)}`),
    promptSection("current_progress", "user", `Current progress:\n${JSON.stringify(input.progress)}`),
    promptSection("current_verification", "user", buildHelarcVerificationText({
      context,
      toolExposure: input.toolExposure,
      verification: input.verification,
    })),
    promptSection("permission_context", "user", `Permission context:\n${JSON.stringify(input.permission)}`),
    promptSection("pending_interactions", "user", `Pending interactions:\n${JSON.stringify(input.pending)}`),
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
  _toolExposure: ControllerInput["toolExposure"],
): readonly HelarcPromptSection[] {
  return Object.freeze([
    promptSection(
      "native_tool_protocol",
      "instruction",
      [
        "Use only callable definitions supplied with the current model request.",
        "Use update_plan when an explicit plan helps the work; simple tasks may proceed without a plan.",
        "Use stop as the only call when the task cannot be completed safely or required information is unavailable.",
        "Return a normal assistant response with no calls only when the task is complete.",
        "Assistant text accompanying calls describes progress and does not complete the Run.",
      ].join("\n"),
    ),
    promptSection(
      "permission_safety",
      "instruction",
      "Use only the active Tool catalog. Permission, approval, policy, and sandbox decisions are enforced by the host from the exact requested action.",
    ),
    promptSection(
      "stop_protocol",
      "instruction",
      "Use the stop callable with one bounded reason; refusal may also stop without a callable.",
    ),
    promptSection(
      "safe_output_boundary",
      "instruction",
      "Never include workspace root paths, credentials, approval decisions, original content hashes, or patch ids.",
    ),
  ]);
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
