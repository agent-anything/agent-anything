import type { PlannerInput, PlanStep } from "@agent-anything/agent-core";
import type { ProviderResponse } from "@agent-anything/providers";
import {
  buildHelarcProviderRequest,
  HelarcPlannerParseError,
  parseHelarcProviderResponse,
} from "./HelarcPlanner.js";
import {
  createHelarcToolCatalogMetadata,
  HELARC_TOOL_CATALOG_METADATA_KEY,
  type HelarcToolCatalogMode,
} from "./HelarcToolCatalog.js";

export type HelarcProtocolEvalExpectedResult =
  | {
      kind: "planStep";
      action: "call_tool";
      planStepKind: "callTool";
      toolName: string;
    }
  | {
      kind: "planStep";
      action: "complete";
      planStepKind: "final";
      finalOutputKind: "complete";
    }
  | {
      kind: "planStep";
      action: "propose";
      planStepKind: "final";
      finalOutputKind: "propose";
      changeOperation: "create" | "update" | "delete";
    }
  | {
      kind: "error";
      code: string;
    };

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
  const input = createProtocolEvalPlannerInput(fixture);
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
    actual = mapPlanStep(parseHelarcProviderResponse(response(fixture.providerOutput), input));
  } catch (error) {
    if (!(error instanceof HelarcPlannerParseError)) {
      throw error;
    }

    actual = {
      kind: "error",
      code: error.code,
    };
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

function createProtocolEvalPlannerInput(fixture: HelarcProtocolEvalFixture): PlannerInput {
  return {
    task: {
      id: fixture.id,
      kind: "helarc.code-task",
      input: { prompt: fixture.taskPrompt },
      createdAt: "2026-07-08T00:00:00.000Z",
      metadata: {},
    },
    context: {
      taskId: fixture.id,
      messages: [],
      observations: [],
      evidenceRefs: [],
      metadata: {},
    },
    metadata: {
      [HELARC_TOOL_CATALOG_METADATA_KEY]: createHelarcToolCatalogMetadata({
        mode: fixture.mode,
        tools: toolDefinitionsForMode(fixture.mode),
      }),
    },
  };
}

function toolDefinitionsForMode(mode: HelarcToolCatalogMode) {
  const readOnlyTools = [
    {
      name: "codeAgent.listFiles",
      description: "List files inside a declared task workspace root.",
      risk: "safe",
    },
    {
      name: "codeAgent.readFile",
      description: "Read one file inside a declared task workspace root.",
      risk: "safe",
    },
    {
      name: "codeAgent.searchFiles",
      description: "Search text across files inside a declared task workspace root.",
      risk: "safe",
    },
  ] as const;

  if (mode === "read-only") {
    return readOnlyTools;
  }

  return [
    ...readOnlyTools,
    {
      name: "codeAgent.runCommand",
      description: "Run a process inside a declared task workspace root.",
      risk: "risky",
    },
  ] as const;
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

function mapPlanStep(step: PlanStep): HelarcProtocolEvalExpectedResult {
  if (step.kind === "callTool") {
    return {
      kind: "planStep",
      action: "call_tool",
      planStepKind: "callTool",
      toolName: step.toolCall.toolName,
    };
  }

  if (step.kind === "final") {
    const output = step.finalOutput as { kind?: unknown; change?: { operation?: unknown } };
    if (output.kind === "propose") {
      return {
        kind: "planStep",
        action: "propose",
        planStepKind: "final",
        finalOutputKind: "propose",
        changeOperation: output.change?.operation as "create" | "update" | "delete",
      };
    }

    return {
      kind: "planStep",
      action: "complete",
      planStepKind: "final",
      finalOutputKind: "complete",
    };
  }

  return {
    kind: "error",
    code: `unexpected_plan_step_${step.kind}`,
  };
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
