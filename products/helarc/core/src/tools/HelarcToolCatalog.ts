import type { ControllerInput } from "@agent-anything/agent-runtime/controller";
import {
  CODE_AGENT_EDIT_TOOL,
  CODE_AGENT_GLOB_TOOL,
  CODE_AGENT_GREP_TOOL,
  CODE_AGENT_READ_TOOL,
  CODE_AGENT_WRITE_TOOL,
} from "@agent-anything/helarc-code-agent/file-operation";
import { findHelarcBaselineToolContract } from "./HelarcBaselineToolContracts.js";
import { HELARC_TASK_STOP_TOOL } from "./HelarcCommandOperation.js";
import { HELARC_RUN_VALIDATION_CHECK_TOOL } from "../validation/HelarcValidationCheckOperation.js";

import type {
  ToolAnnotations,
  ToolJsonObject,
} from "@agent-anything/tools/catalog";

export interface HelarcToolCatalogItem {
  name: string;
  purpose: string;
  inputSchema: ToolJsonObject;
  annotations: ToolAnnotations;
  permission: string;
}

export interface HelarcToolDescriptorSummary {
  name: string;
  description?: string | null;
  inputSchema: ToolJsonObject;
  annotations: ToolAnnotations;
}

export interface HelarcToolCatalog {
  tools: HelarcToolCatalogItem[];
}

export interface HelarcToolCatalogMetadata {
  profile: "code-agent";
}

export const HELARC_TOOL_CATALOG_METADATA_KEY = "helarcToolCatalog";

const HELARC_TOOL_ORDER = [
  CODE_AGENT_READ_TOOL,
  CODE_AGENT_GLOB_TOOL,
  CODE_AGENT_GREP_TOOL,
  CODE_AGENT_EDIT_TOOL,
  CODE_AGENT_WRITE_TOOL,
  "Bash",
  "PowerShell",
  HELARC_TASK_STOP_TOOL,
  HELARC_RUN_VALIDATION_CHECK_TOOL,
] as const;

const HELARC_TOOL_PURPOSES: Record<string, string> = {
  [CODE_AGENT_READ_TOOL]: "Read bounded text from one Workspace file.",
  [CODE_AGENT_GLOB_TOOL]: "Find Workspace paths with a bounded glob pattern.",
  [CODE_AGENT_GREP_TOOL]: "Search Workspace text with a bounded regular expression.",
  [CODE_AGENT_EDIT_TOOL]: "Replace exact text in one existing Workspace file.",
  [CODE_AGENT_WRITE_TOOL]: "Create or replace one complete Workspace file.",
  Bash: "Execute one bounded native Bash command.",
  PowerShell: "Execute one bounded native PowerShell command.",
  [HELARC_TASK_STOP_TOOL]: "Stop one exact background command owned by the current Run.",
  [HELARC_RUN_VALIDATION_CHECK_TOOL]: "Run one admitted engineering validation command and assess its declared claim.",
};

export function createHelarcToolCatalogFromDescriptors(input: {
  tools: readonly HelarcToolDescriptorSummary[];
}): HelarcToolCatalog {
  const byName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const tools = HELARC_TOOL_ORDER
    .map((name) => byName.get(name))
    .filter((tool): tool is HelarcToolDescriptorSummary => tool !== undefined)
    .map((tool) => createCatalogItem(tool));

  return { tools };
}

export function createDefaultHelarcToolCatalog(): HelarcToolCatalog {
  return createHelarcToolCatalogFromDescriptors({
    tools: ([
      CODE_AGENT_READ_TOOL,
      CODE_AGENT_GLOB_TOOL,
      CODE_AGENT_GREP_TOOL,
      CODE_AGENT_EDIT_TOOL,
      CODE_AGENT_WRITE_TOOL,
    ] as const).map((name) => {
      const contract = findHelarcBaselineToolContract(name);
      return {
        name,
        description: contract.description,
        inputSchema: contract.inputSchema,
        annotations: contract.annotations,
      };
    }),
  });
}

export function createHelarcToolCatalogMetadata(): HelarcToolCatalogMetadata {
  return { profile: "code-agent" };
}

export function readHelarcToolCatalog(
  input: Pick<ControllerInput, "metadata" | "toolExposure">,
): HelarcToolCatalog {
  return createHelarcToolCatalogFromDescriptors({
    tools: input.toolExposure.catalog.tools,
  });
}

export function buildHelarcToolCatalogText(catalog: HelarcToolCatalog): string {
  const lines = [
    "Active tool catalog:",
    ...catalog.tools.map((tool) => (
      `- ${tool.name}: ${tool.purpose} Input JSON Schema: ${JSON.stringify(tool.inputSchema)}. Permission: ${tool.permission}.`
    )),
  ];

  lines.push("Use the native Shell only when command execution is necessary.");
  lines.push("Use TaskStop to stop an exact background task returned by the Shell.");
  lines.push("Use codeAgent.runValidationCheck when command output must support an admitted engineering validation claim.");

  return lines.join("\n");
}

function createCatalogItem(
  tool: HelarcToolDescriptorSummary,
): HelarcToolCatalogItem {
  return {
    name: tool.name,
    purpose: tool.description ?? HELARC_TOOL_PURPOSES[tool.name] ?? "Execute the registered tool.",
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    permission: tool.name === "Bash" || tool.name === "PowerShell" || tool.name === HELARC_TASK_STOP_TOOL || tool.name === HELARC_RUN_VALIDATION_CHECK_TOOL
      ? "Assessed from the exact process action and current run authority"
      : "Assessed from canonical filesystem effects and current run authority",
  };
}
