import type {
  ControllerInput,
  ControllerPreProjectionInput,
} from "@agent-anything/agent-runtime/controller";
import type {
  ContextProjection,
  ContextProjectionEstimationInput,
} from "@agent-anything/context/projection";
import type { ModelInputSectionCandidate } from "@agent-anything/model-interaction/input";
import {
  buildHelarcActionDecisionRulesText,
  buildHelarcActionProtocolText,
} from "../controller/HelarcActionContract.js";
import type { HelarcTaskInput } from "../task/HelarcTaskInput.js";
import {
  buildHelarcToolCatalogText,
  readHelarcToolCatalog,
  type HelarcToolCatalog,
} from "../tools/HelarcToolCatalog.js";

export const HELARC_PROMPT_ARCHITECTURE_VERSION = "helarc-prompt-v2";
export const HELARC_ACTION_CONTRACT_VERSION = "helarc-action-v2";
export const HELARC_TOOL_CATALOG_VERSION = "helarc-tool-catalog-v2";
export const HELARC_CONTEXT_PROJECTION_FORMAT_VERSION = "helarc-context-projection-v1";
export const HELARC_CONTEXT_SECTION_HEADER = "Context projection:";
export const HELARC_MODEL_OUTPUT_RESERVE_BYTES = 256_000;

export type HelarcPromptSectionId =
  | "agent_identity"
  | "output_format"
  | "action_protocol"
  | "action_decision_rules"
  | "tool_catalog"
  | "permission_safety"
  | "patch_workflow"
  | "stop_protocol"
  | "safe_output_boundary"
  | "task"
  | "run_input_items"
  | "context_projection"
  | "current_plan"
  | "permission_context"
  | "pending_interactions"
  | "structured_output_correction";

export interface HelarcPromptSection {
  readonly id: HelarcPromptSectionId;
  readonly role: ModelInputSectionCandidate["role"];
  readonly necessity: ModelInputSectionCandidate["necessity"];
  readonly content: string;
}

export interface HelarcPromptAssemblyVersions {
  promptArchitectureVersion: typeof HELARC_PROMPT_ARCHITECTURE_VERSION;
  actionContractVersion: typeof HELARC_ACTION_CONTRACT_VERSION;
  toolCatalogVersion: typeof HELARC_TOOL_CATALOG_VERSION;
  contextProjectionFormatVersion: typeof HELARC_CONTEXT_PROJECTION_FORMAT_VERSION;
}

export interface HelarcPromptAssemblyResult {
  readonly sections: readonly ModelInputSectionCandidate[];
  readonly promptSections: readonly HelarcPromptSection[];
  readonly exposedToolNames: readonly string[];
  readonly toolCatalog: HelarcToolCatalog;
  readonly versions: HelarcPromptAssemblyVersions;
}

export function buildHelarcBasePromptAssembly(
  input: ControllerPreProjectionInput,
): HelarcPromptAssemblyResult {
  return assemble(input, HELARC_CONTEXT_SECTION_HEADER, null, null);
}

export function buildHelarcPromptAssembly(input: {
  readonly controllerInput: ControllerInput;
  readonly correctionMessage: string | null;
}): HelarcPromptAssemblyResult {
  return assemble(
    input.controllerInput,
    renderHelarcContextProjection(input.controllerInput.context),
    input.controllerInput.context,
    input.correctionMessage,
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
  correctionMessage: string | null,
): HelarcPromptAssemblyResult {
  const toolCatalog = readHelarcToolCatalog(input);
  const exposedToolNames = Object.freeze(toolCatalog.tools.map((tool) => tool.name));
  const promptSections = Object.freeze([
    ...buildSystemPromptSections(toolCatalog),
    promptSection("task", "user", `Task:\n${readHelarcTaskPrompt(input)}`),
    promptSection("run_input_items", "user", `Run input items:\n${JSON.stringify(input.inputItems)}`),
    promptSection("context_projection", "user", contextContent),
    promptSection("current_plan", "user", `Current plan:\n${JSON.stringify(input.plan)}`),
    promptSection("permission_context", "user", `Permission context:\n${JSON.stringify(input.permission)}`),
    promptSection("pending_interactions", "user", `Pending interactions:\n${JSON.stringify(input.pending)}`),
    ...(correctionMessage === null
      ? []
      : [promptSection("structured_output_correction", "user", correctionMessage)]),
  ]);
  const sections = Object.freeze(promptSections.map((section) =>
    toModelInputSection(section, context),
  ));
  return Object.freeze({
    sections,
    promptSections,
    exposedToolNames,
    toolCatalog,
    versions: Object.freeze({
      promptArchitectureVersion: HELARC_PROMPT_ARCHITECTURE_VERSION,
      actionContractVersion: HELARC_ACTION_CONTRACT_VERSION,
      toolCatalogVersion: HELARC_TOOL_CATALOG_VERSION,
      contextProjectionFormatVersion: HELARC_CONTEXT_PROJECTION_FORMAT_VERSION,
    }),
  });
}

function buildSystemPromptSections(
  toolCatalog: HelarcToolCatalog,
): readonly HelarcPromptSection[] {
  return Object.freeze([
    promptSection("agent_identity", "system", "You are Helarc, a careful code agent."),
    promptSection("output_format", "system", "Return only JSON. Do not wrap it in markdown."),
    promptSection("action_protocol", "system", buildHelarcActionProtocolText()),
    promptSection("action_decision_rules", "system", buildHelarcActionDecisionRulesText()),
    promptSection("tool_catalog", "system", buildHelarcToolCatalogText(toolCatalog)),
    promptSection(
      "permission_safety",
      "system",
      "Do not call shell, write, patch, or long-running process tools unless the host explicitly enables them.",
    ),
    promptSection(
      "patch_workflow",
      "system",
      "For propose change, use operation create/update/delete, path, and content when needed.",
    ),
    promptSection(
      "stop_protocol",
      "system",
      [
        "For complete, return action and summary.",
        "For stop, return action and reason.",
      ].join("\n"),
    ),
    promptSection(
      "safe_output_boundary",
      "system",
      "Never include workspace root paths, credentials, approval decisions, original content hashes, or patch ids.",
    ),
  ]);
}

function promptSection(
  id: HelarcPromptSectionId,
  role: ModelInputSectionCandidate["role"],
  content: string,
): HelarcPromptSection {
  return Object.freeze({ id, role, necessity: "mandatory" as const, content });
}

function toModelInputSection(
  section: HelarcPromptSection,
  context: ContextProjection | null,
): ModelInputSectionCandidate {
  const isContext = section.id === "context_projection";
  return Object.freeze({
    id: `helarc:model-input:${section.id}`,
    source: isContext && context !== null
      ? Object.freeze({
          owner: "context",
          kind: "context_projection",
          id: context.id,
          revision: String(context.activeContext.version),
        })
      : Object.freeze({
          owner: "helarc",
          kind: "prompt_section",
          id: section.id,
          revision: HELARC_PROMPT_ARCHITECTURE_VERSION,
        }),
    kind: isContext ? "context_projection" : "product_prompt",
    role: section.role,
    necessity: section.necessity,
    content: Object.freeze({ kind: "text" as const, text: section.content }),
  });
}

function renderHelarcContextProjection(context: ContextProjection): string {
  return HELARC_CONTEXT_SECTION_HEADER + context.blocks.map((block) =>
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
