import type { ControllerInput } from "@agent-anything/agent-runtime/controller";
import {
  CODE_AGENT_LIST_FILES_TOOL,
  CODE_AGENT_READ_FILE_TOOL,
  CODE_AGENT_SEARCH_FILES_TOOL,
} from "@agent-anything/helarc-code-agent/file-operation";
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
  CODE_AGENT_LIST_FILES_TOOL,
  CODE_AGENT_READ_FILE_TOOL,
  CODE_AGENT_SEARCH_FILES_TOOL,
  HELARC_RUN_COMMAND_TOOL,
  HELARC_RUN_VALIDATION_CHECK_TOOL,
] as const;

const HELARC_TOOL_PURPOSES: Record<string, string> = {
  [CODE_AGENT_LIST_FILES_TOOL]: "List files inside a declared task workspace root.",
  [CODE_AGENT_READ_FILE_TOOL]: "Read one file inside a declared task workspace root.",
  [CODE_AGENT_SEARCH_FILES_TOOL]: "Search text across files inside a declared task workspace root.",
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
    tools: [
      {
        name: CODE_AGENT_LIST_FILES_TOOL,
        description: HELARC_TOOL_PURPOSES[CODE_AGENT_LIST_FILES_TOOL],
        inputSchema: defaultFileToolInputSchema("list"),
        annotations: { readOnlyHint: true },
      },
      {
        name: CODE_AGENT_READ_FILE_TOOL,
        description: HELARC_TOOL_PURPOSES[CODE_AGENT_READ_FILE_TOOL],
        inputSchema: defaultFileToolInputSchema("read"),
        annotations: { readOnlyHint: true },
      },
      {
        name: CODE_AGENT_SEARCH_FILES_TOOL,
        description: HELARC_TOOL_PURPOSES[CODE_AGENT_SEARCH_FILES_TOOL],
        inputSchema: defaultFileToolInputSchema("search"),
        annotations: { readOnlyHint: true },
      },
    ],
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

  if (catalog.mode === "read-only") {
    lines.push("File creation, update, and deletion are not tool calls in read-only mode; use propose.");
  }

  if (catalog.mode === "shell-enabled") {
    lines.push("Use codeAgent.runCommand only when command execution is necessary and cannot be represented as a patch proposal.");
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

function defaultFileToolInputSchema(operation: "list" | "read" | "search"): ToolJsonObject {
  const properties: Record<string, ToolJsonObject> = {
    rootName: { type: "string" },
    path: { type: "string" },
  };
  const required = ["path"];
  if (operation === "list") {
    properties.recursive = { type: "boolean" };
  }
  if (operation === "search") {
    properties.query = { type: "string", minLength: 1 };
    required.push("query");
  }
  return { type: "object", additionalProperties: false, required, properties };
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
