import type { PlannerInput } from "@agent-anything/agent-core";
import {
  buildHelarcActionDecisionRulesText,
  buildHelarcActionProtocolText,
} from "./HelarcActionContract.js";
import type { HelarcTaskInput } from "../task/index.js";
import {
  buildHelarcToolCatalogText,
  readHelarcToolCatalog,
  type HelarcToolCatalog,
} from "./HelarcToolCatalog.js";

export const HELARC_PROMPT_ARCHITECTURE_VERSION = "helarc-prompt-v1";
export const HELARC_ACTION_CONTRACT_VERSION = "helarc-action-v1";
export const HELARC_TOOL_CATALOG_VERSION = "helarc-tool-catalog-v1";

export type HelarcPromptSectionId =
  | "agent_identity"
  | "output_format"
  | "action_protocol"
  | "action_decision_rules"
  | "tool_catalog"
  | "permission_safety"
  | "patch_workflow"
  | "stop_protocol"
  | "safe_output_boundary";

export interface HelarcPromptSection {
  id: HelarcPromptSectionId;
  content: string;
}

export interface HelarcPromptAssemblyInput {
  plannerInput: PlannerInput;
  toolCatalog?: HelarcToolCatalog;
}

export interface HelarcPromptAssemblyVersions {
  promptArchitectureVersion: typeof HELARC_PROMPT_ARCHITECTURE_VERSION;
  actionContractVersion: typeof HELARC_ACTION_CONTRACT_VERSION;
  toolCatalogVersion: typeof HELARC_TOOL_CATALOG_VERSION;
}

export interface HelarcPromptAssemblyResult {
  systemPrompt: string;
  userPrompt: string;
  systemSections: HelarcPromptSection[];
  exposedToolNames: string[];
  toolCatalog: HelarcToolCatalog;
  versions: HelarcPromptAssemblyVersions;
}

export function buildHelarcPromptAssembly(
  input: HelarcPromptAssemblyInput,
): HelarcPromptAssemblyResult {
  const toolCatalog = input.toolCatalog ?? readHelarcToolCatalog(input.plannerInput);
  const exposedToolNames = toolCatalog.tools.map((tool) => tool.name);
  const systemSections = buildSystemPromptSections(toolCatalog);
  const taskPrompt = readHelarcTaskPrompt(input.plannerInput);

  return {
    systemPrompt: systemSections.map((section) => section.content).join("\n"),
    userPrompt: buildUserPrompt(taskPrompt, input.plannerInput),
    systemSections,
    exposedToolNames,
    toolCatalog,
    versions: {
      promptArchitectureVersion: HELARC_PROMPT_ARCHITECTURE_VERSION,
      actionContractVersion: HELARC_ACTION_CONTRACT_VERSION,
      toolCatalogVersion: HELARC_TOOL_CATALOG_VERSION,
    },
  };
}

function buildSystemPromptSections(
  toolCatalog: HelarcToolCatalog,
): HelarcPromptSection[] {
  return [
    {
      id: "agent_identity",
      content: "You are Helarc, a careful code agent planner.",
    },
    {
      id: "output_format",
      content: "Return only JSON. Do not wrap it in markdown.",
    },
    {
      id: "action_protocol",
      content: buildHelarcActionProtocolText(),
    },
    {
      id: "action_decision_rules",
      content: buildHelarcActionDecisionRulesText(),
    },
    {
      id: "tool_catalog",
      content: buildHelarcToolCatalogText(toolCatalog),
    },
    {
      id: "permission_safety",
      content: "Do not call shell, write, patch, or long-running process tools unless the host explicitly enables them.",
    },
    {
      id: "patch_workflow",
      content: "For propose change, use operation create/update/delete, path, and content when needed.",
    },
    {
      id: "stop_protocol",
      content: [
        "For complete, return action and summary.",
        "For stop, return action and reason.",
      ].join("\n"),
    },
    {
      id: "safe_output_boundary",
      content: "Never include workspace root paths, credentials, approval decisions, original content hashes, or patch ids.",
    },
  ];
}

function buildUserPrompt(taskPrompt: string, input: PlannerInput): string {
  return [
    "Task:",
    taskPrompt,
    "",
    "Context messages:",
    JSON.stringify(input.context.messages),
    "",
    "Observations:",
    JSON.stringify(input.context.observations),
    "",
    "Evidence refs:",
    JSON.stringify(input.context.evidenceRefs),
  ].join("\n");
}

function readHelarcTaskPrompt(input: PlannerInput): string {
  const taskInput = input.task.input as Partial<HelarcTaskInput>;
  return typeof taskInput.prompt === "string" ? taskInput.prompt : "";
}
