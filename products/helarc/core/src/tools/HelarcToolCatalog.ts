import type { ControllerInput } from "@agent-anything/agent-runtime/controller";
import {
  CODE_AGENT_EDIT_TOOL,
  CODE_AGENT_GLOB_TOOL,
  CODE_AGENT_GREP_TOOL,
  CODE_AGENT_READ_TOOL,
  CODE_AGENT_WRITE_TOOL,
} from "@agent-anything/helarc-code-agent/file-operation";
import { findHelarcBaselineToolContract } from "./HelarcBaselineToolContracts.js";
import { HELARC_RUN_COMMAND_TOOL } from "./HelarcCommandOperation.js";
import { HELARC_RUN_VALIDATION_CHECK_TOOL } from "../validation/HelarcValidationCheckOperation.js";

import type {
  ToolAnnotations,
  ToolDescriptor,
  ToolJsonObject,
} from "@agent-anything/tools/catalog";

export type HelarcToolCatalogMode = "read-only" | "shell-enabled";

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
  mode: HelarcToolCatalogMode;
  tools: HelarcToolCatalogItem[];
}

export interface HelarcToolCatalogMetadata {
  mode: HelarcToolCatalogMode;
}

export const HELARC_TOOL_CATALOG_METADATA_KEY = "helarcToolCatalog";

const HELARC_TOOL_ORDER = [
  CODE_AGENT_READ_TOOL,
  CODE_AGENT_GLOB_TOOL,
  CODE_AGENT_GREP_TOOL,
  CODE_AGENT_EDIT_TOOL,
  CODE_AGENT_WRITE_TOOL,
  HELARC_RUN_COMMAND_TOOL,
  HELARC_RUN_VALIDATION_CHECK_TOOL,
] as const;

const HELARC_TOOL_PURPOSES: Record<string, string> = {
  [CODE_AGENT_READ_TOOL]: "Read bounded text from one Workspace file.",
  [CODE_AGENT_GLOB_TOOL]: "Find Workspace paths with a bounded glob pattern.",
  [CODE_AGENT_GREP_TOOL]: "Search Workspace text with a bounded regular expression.",
  [CODE_AGENT_EDIT_TOOL]: "Replace exact text in one existing Workspace file.",
  [CODE_AGENT_WRITE_TOOL]: "Create or replace one complete Workspace file.",
  [HELARC_RUN_COMMAND_TOOL]: "Run a process inside a declared task workspace root.",
  [HELARC_RUN_VALIDATION_CHECK_TOOL]: "Run one admitted engineering validation command and assess its declared claim.",
};

export function createHelarcToolCatalogFromDescriptors(input: {
  mode: HelarcToolCatalogMode;
  tools: readonly HelarcToolDescriptorSummary[];
}): HelarcToolCatalog {
  const byName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const tools = HELARC_TOOL_ORDER
    .map((name) => byName.get(name))
    .filter((tool): tool is HelarcToolDescriptorSummary => tool !== undefined)
    .map((tool) => createCatalogItem(tool));

  return {
    mode: input.mode,
    tools,
  };
}

export function createDefaultHelarcToolCatalog(): HelarcToolCatalog {
  return createHelarcToolCatalogFromDescriptors({
    mode: "read-only",
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

export function createHelarcToolCatalogMetadata(input: {
  mode: HelarcToolCatalogMode;
}): HelarcToolCatalogMetadata {
  return {
    mode: input.mode,
  };
}

export function readHelarcToolCatalog(
  input: Pick<ControllerInput, "metadata" | "toolExposure">,
): HelarcToolCatalog {
  const metadata = input.metadata[HELARC_TOOL_CATALOG_METADATA_KEY];
  const catalogMetadata = parseHelarcToolCatalogMetadata(metadata);

  return createHelarcToolCatalogFromDescriptors({
    mode: catalogMetadata?.mode ?? inferCatalogMode(input.toolExposure.catalog.tools),
    tools: input.toolExposure.catalog.tools,
  });
}

export function buildHelarcToolCatalogText(catalog: HelarcToolCatalog): string {
  const lines = [
    `Active tool catalog (${catalog.mode}):`,
    ...catalog.tools.map((tool) => (
      `- ${tool.name}: ${tool.purpose} Input JSON Schema: ${JSON.stringify(tool.inputSchema)}. Permission: ${tool.permission}.`
    )),
  ];

  if (catalog.mode === "shell-enabled") {
    lines.push("Use codeAgent.runCommand only when command execution is necessary.");
    lines.push("Use codeAgent.runValidationCheck when command output must support an admitted engineering validation claim.");
  }

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
    permission: tool.name === HELARC_RUN_COMMAND_TOOL || tool.name === HELARC_RUN_VALIDATION_CHECK_TOOL
      ? "Assessed from the exact process action and current run authority"
      : "Assessed from canonical filesystem effects and current run authority",
  };
}

function parseHelarcToolCatalogMetadata(value: unknown): HelarcToolCatalogMetadata | null {
  if (!isRecord(value)) {
    return null;
  }

  const mode = value.mode;
  if (mode !== "read-only" && mode !== "shell-enabled") {
    return null;
  }

  return { mode };
}

function inferCatalogMode(
  tools: readonly Pick<ToolDescriptor, "name">[],
): HelarcToolCatalogMode {
  return tools.some((tool) => tool.name === HELARC_RUN_COMMAND_TOOL ||
    tool.name === HELARC_RUN_VALIDATION_CHECK_TOOL)
    ? "shell-enabled"
    : "read-only";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
