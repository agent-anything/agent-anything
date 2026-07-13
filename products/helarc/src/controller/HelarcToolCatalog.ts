import type { ControllerInput } from "@agent-anything/agent-core";
import {
  CODE_AGENT_LIST_FILES_TOOL,
  CODE_AGENT_READ_FILE_TOOL,
  CODE_AGENT_RUN_COMMAND_TOOL,
  CODE_AGENT_SEARCH_FILES_TOOL,
} from "@agent-anything/code-agent";
import type { Metadata } from "@agent-anything/shared";
import type { ToolDefinition, ToolRisk } from "@agent-anything/tools";

export type HelarcToolCatalogMode = "read-only" | "shell-enabled";

export interface HelarcToolCatalogItem {
  name: string;
  purpose: string;
  risk: ToolRisk;
  permission: string;
}

export interface HelarcToolDefinitionSummary {
  name: string;
  description?: string | null;
  risk: ToolRisk;
}

export interface HelarcToolCatalog {
  mode: HelarcToolCatalogMode;
  tools: HelarcToolCatalogItem[];
}

export interface HelarcToolCatalogMetadata {
  mode: HelarcToolCatalogMode;
  tools: Array<{
    name: string;
    description: string | null;
    risk: ToolRisk;
  }>;
}

export const HELARC_TOOL_CATALOG_METADATA_KEY = "helarcToolCatalog";

const HELARC_TOOL_ORDER = [
  CODE_AGENT_LIST_FILES_TOOL,
  CODE_AGENT_READ_FILE_TOOL,
  CODE_AGENT_SEARCH_FILES_TOOL,
  CODE_AGENT_RUN_COMMAND_TOOL,
] as const;

const HELARC_TOOL_PURPOSES: Record<string, string> = {
  [CODE_AGENT_LIST_FILES_TOOL]: "List files inside a declared task workspace root.",
  [CODE_AGENT_READ_FILE_TOOL]: "Read one file inside a declared task workspace root.",
  [CODE_AGENT_SEARCH_FILES_TOOL]: "Search text across files inside a declared task workspace root.",
  [CODE_AGENT_RUN_COMMAND_TOOL]: "Run a process inside a declared task workspace root.",
};

export function createHelarcToolCatalogFromDefinitions(input: {
  mode: HelarcToolCatalogMode;
  tools: readonly HelarcToolDefinitionSummary[];
}): HelarcToolCatalog {
  const byName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const tools = HELARC_TOOL_ORDER
    .map((name) => byName.get(name))
    .filter((tool): tool is HelarcToolDefinitionSummary => tool !== undefined)
    .map((tool) => createCatalogItem(tool));

  return {
    mode: input.mode,
    tools,
  };
}

export function createDefaultHelarcToolCatalog(): HelarcToolCatalog {
  return createHelarcToolCatalogFromDefinitions({
    mode: "read-only",
    tools: [
      {
        name: CODE_AGENT_LIST_FILES_TOOL,
        description: HELARC_TOOL_PURPOSES[CODE_AGENT_LIST_FILES_TOOL],
        risk: "safe",
      },
      {
        name: CODE_AGENT_READ_FILE_TOOL,
        description: HELARC_TOOL_PURPOSES[CODE_AGENT_READ_FILE_TOOL],
        risk: "safe",
      },
      {
        name: CODE_AGENT_SEARCH_FILES_TOOL,
        description: HELARC_TOOL_PURPOSES[CODE_AGENT_SEARCH_FILES_TOOL],
        risk: "safe",
      },
    ],
  });
}

export function createHelarcToolCatalogMetadata(input: {
  mode: HelarcToolCatalogMode;
  tools: readonly Pick<ToolDefinition, "name" | "description" | "risk">[];
}): HelarcToolCatalogMetadata {
  return {
    mode: input.mode,
    tools: input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? null,
      risk: tool.risk,
    })),
  };
}

export function readHelarcToolCatalog(input: ControllerInput): HelarcToolCatalog {
  const metadata = input.metadata[HELARC_TOOL_CATALOG_METADATA_KEY];
  const catalogMetadata = parseHelarcToolCatalogMetadata(metadata);
  if (!catalogMetadata) {
    return createDefaultHelarcToolCatalog();
  }

  return createHelarcToolCatalogFromDefinitions({
    mode: catalogMetadata.mode,
    tools: catalogMetadata.tools,
  });
}

export function buildHelarcToolCatalogText(catalog: HelarcToolCatalog): string {
  const lines = [
    `Active tool catalog (${catalog.mode}):`,
    ...catalog.tools.map((tool) => (
      `- ${tool.name}: ${tool.purpose} Risk: ${tool.risk}. Permission: ${tool.permission}.`
    )),
  ];

  if (catalog.mode === "read-only") {
    lines.push("File creation, update, and deletion are not tool calls in read-only mode; use propose.");
  }

  if (catalog.mode === "shell-enabled") {
    lines.push("Use codeAgent.runCommand only when command execution is necessary and cannot be represented as a patch proposal.");
  }

  return lines.join("\n");
}

function createCatalogItem(
  tool: HelarcToolDefinitionSummary,
): HelarcToolCatalogItem {
  return {
    name: tool.name,
    purpose: tool.description ?? HELARC_TOOL_PURPOSES[tool.name] ?? "Execute the registered tool.",
    risk: tool.risk,
    permission: tool.risk === "risky"
      ? "Requires policy and permission approval when the host is in ask mode"
      : "Available without additional approval in the current trusted workspace mode",
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

  if (!Array.isArray(value.tools)) {
    return null;
  }

  const tools = value.tools.flatMap((tool) => {
    if (!isRecord(tool)) {
      return [];
    }

    const name = tool.name;
    const description = tool.description;
    const risk = tool.risk;
    if (
      typeof name !== "string" ||
      (description !== null && typeof description !== "string") ||
      (risk !== "safe" && risk !== "risky")
    ) {
      return [];
    }

    const parsedRisk: ToolRisk = risk;
    return [{
      name,
      description,
      risk: parsedRisk,
    }];
  });

  return {
    mode,
    tools,
  };
}

function isRecord(value: unknown): value is Metadata {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
