import type {
  ControllerDecision,
  ControllerInput,
} from "@agent-anything/agent-core";
import type { ProviderResponse } from "@agent-anything/providers";
import type { ToolDefinition } from "@agent-anything/tools";
import {
  buildHelarcProviderRequest,
  HelarcControllerParseError,
  parseHelarcProviderResponse,
  type HelarcAgentOutput,
} from "./HelarcController.js";
import {
  createHelarcToolCatalogMetadata,
  HELARC_TOOL_CATALOG_METADATA_KEY,
  type HelarcToolCatalogMode,
} from "./HelarcToolCatalog.js";

export type HelarcProtocolEvalExpectedResult =
  | {
      kind: "decision";
      action: "call_tool";
      decisionKind: "actions";
      actionKind: "tool";
      toolName: string;
    }
  | {
      kind: "decision";
      action: "update_plan";
      decisionKind: "actions";
      actionKind: "internal";
    }
  | {
      kind: "decision";
      action: "complete";
      decisionKind: "final_output";
      finalOutputKind: "complete";
    }
  | {
      kind: "decision";
      action: "propose";
      decisionKind: "final_output";
      finalOutputKind: "propose";
      changeOperation: "create" | "update" | "delete";
    }
  | { kind: "error"; code: string };

export interface HelarcProtocolEvalFixture {
  id: string;
  taskPrompt: string;
  mode: HelarcToolCatalogMode;
  providerOutput: unknown;
  expectedExposedToolNames: string[];
  expected: HelarcProtocolEvalExpectedResult;
}

export interface HelarcProtocolEvalResult {
  fixtureId: string;
  passed: boolean;
  actualExposedToolNames: string[];
  actual?: HelarcProtocolEvalExpectedResult;
  failureMessage?: string;
}

export function runHelarcProtocolEvalFixture(
  fixture: HelarcProtocolEvalFixture,
): HelarcProtocolEvalResult {
  const input = createProtocolEvalControllerInput(fixture);
  const request = buildHelarcProviderRequest(input);
  const actualExposedToolNames = readExposedToolNames(request.metadata.exposedToolNames);
  const exposedToolNamesFailure = compareArray(
    "exposedToolNames",
    actualExposedToolNames,
    fixture.expectedExposedToolNames,
  );
  if (exposedToolNamesFailure) {
    return {
      fixtureId: fixture.id,
      passed: false,
      actualExposedToolNames,
      failureMessage: exposedToolNamesFailure,
    };
  }

  let actual: HelarcProtocolEvalExpectedResult;
  try {
    actual = mapDecision(parseHelarcProviderResponse(
      response(fixture.providerOutput),
      input,
    ));
  } catch (error) {
    if (!(error instanceof HelarcControllerParseError)) {
      throw error;
    }
    actual = { kind: "error", code: error.code };
  }

  const failureMessage = compareExpectedResult(actual, fixture.expected);
  return {
    fixtureId: fixture.id,
    passed: !failureMessage,
    actualExposedToolNames,
    actual,
    failureMessage,
  };
}

function createProtocolEvalControllerInput(
  fixture: HelarcProtocolEvalFixture,
): ControllerInput<HelarcAgentOutput> {
  const tools = toolDefinitionsForMode(fixture.mode);
  return {
    runId: `run_${fixture.id}`,
    iteration: 1,
    agent: {
      id: "helarc",
      name: "Helarc",
      instructions: "Complete the code task.",
      tools,
      output: {
        validate(candidate) {
          return { valid: true, output: candidate as HelarcAgentOutput };
        },
      },
      metadata: {},
    },
    task: {
      id: fixture.id,
      kind: "helarc.code-task",
      input: { prompt: fixture.taskPrompt },
      createdAt: "2026-07-08T00:00:00.000Z",
      metadata: {},
    },
    conversationItems: [],
    context: {
      messages: [],
      observations: [],
      evidenceRefs: [],
      plan: null,
      metadata: {},
    },
    workspace: {
      id: "workspace_eval",
      name: "Eval workspace",
      rootRef: "workspace://eval",
      trustState: "trusted",
      source: "eval",
      policyRefs: [],
      metadata: {},
    },
    identity: {
      id: "identity_eval",
      kind: "anonymous",
      displayName: "Eval identity",
      metadata: {},
    },
    metadata: {
      [HELARC_TOOL_CATALOG_METADATA_KEY]: createHelarcToolCatalogMetadata({
        mode: fixture.mode,
        tools,
      }),
    },
  };
}

function toolDefinitionsForMode(mode: HelarcToolCatalogMode): ToolDefinition[] {
  const readOnlyTools = [
    tool("codeAgent.listFiles", "List files inside a declared task workspace root.", "safe"),
    tool("codeAgent.readFile", "Read one file inside a declared task workspace root.", "safe"),
    tool("codeAgent.searchFiles", "Search text across files inside a declared task workspace root.", "safe"),
  ];
  return mode === "read-only"
    ? readOnlyTools
    : [...readOnlyTools, tool(
        "codeAgent.runCommand",
        "Run a process inside a declared task workspace root.",
        "risky",
      )];
}

function tool(
  name: string,
  description: string,
  risk: ToolDefinition["risk"],
): ToolDefinition {
  return {
    name,
    description,
    risk,
    async execute() {
      throw new Error("Protocol eval tools are not executable.");
    },
  };
}

function response(output: unknown): ProviderResponse {
  return {
    status: "succeeded",
    output,
    usage: null,
    error: null,
    metadata: {},
  };
}

function mapDecision(
  decision: ControllerDecision<HelarcAgentOutput>,
): HelarcProtocolEvalExpectedResult {
  if (decision.kind === "actions") {
    const action = decision.actions[0];
    if (action.kind === "tool") {
      return {
        kind: "decision",
        action: "call_tool",
        decisionKind: "actions",
        actionKind: "tool",
        toolName: action.name,
      };
    }
    if (action.kind === "internal" && action.name === "update_plan") {
      return {
        kind: "decision",
        action: "update_plan",
        decisionKind: "actions",
        actionKind: "internal",
      };
    }
  }

  if (decision.kind === "final_output") {
    if (decision.output.kind === "propose") {
      return {
        kind: "decision",
        action: "propose",
        decisionKind: "final_output",
        finalOutputKind: "propose",
        changeOperation: decision.output.change.operation,
      };
    }
    return {
      kind: "decision",
      action: "complete",
      decisionKind: "final_output",
      finalOutputKind: "complete",
    };
  }

  return { kind: "error", code: `unexpected_decision_${decision.kind}` };
}

function readExposedToolNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function compareExpectedResult(
  actual: HelarcProtocolEvalExpectedResult,
  expected: HelarcProtocolEvalExpectedResult,
): string | undefined {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  return actualJson === expectedJson
    ? undefined
    : `expected ${expectedJson}, received ${actualJson}`;
}

function compareArray(
  label: string,
  actual: string[],
  expected: string[],
): string | undefined {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  return actualJson === expectedJson
    ? undefined
    : `${label}: expected ${expectedJson}, received ${actualJson}`;
}
