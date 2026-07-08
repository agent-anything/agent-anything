import { ProviderBackedPlanner, type PlannerInput } from "@agent-anything/agent-core";
import type { Provider, ProviderRequest, ProviderResponse } from "@agent-anything/providers";
import { describe, expect, it } from "vitest";
import {
  buildHelarcActionDecisionRulesText,
  buildHelarcActionProtocolText,
  buildHelarcToolCatalogText,
  buildHelarcProviderRequest,
  buildHelarcPromptAssembly,
  createHelarcActionContract,
  createHelarcToolCatalogFromDefinitions,
  createHelarcToolCatalogMetadata,
  HELARC_PLANNER_OUTPUT_MAX_LENGTH,
  HELARC_TOOL_CATALOG_METADATA_KEY,
  HelarcPlannerParseError,
  parseHelarcProviderResponse,
  parseStructuredOutput,
} from "./index.js";

describe("Helarc planner", () => {
  it("builds a Helarc provider request without workspace authority", () => {
    const request = buildHelarcProviderRequest(createPlannerInput());

    expect(request.capability).toBe("helarc.code-agent.plan");
    expect(request.messages[0]?.role).toBe("system");
    expect(request.messages[0]?.content).toContain("Return only JSON");
    expect(request.messages[1]?.content).toContain("Update docs");
    expect(request.metadata).toMatchObject({
      promptArchitectureVersion: "helarc-prompt-v1",
      actionContractVersion: "helarc-action-v1",
      toolCatalogVersion: "helarc-tool-catalog-v1",
      exposedToolNames: [
        "codeAgent.listFiles",
        "codeAgent.readFile",
        "codeAgent.searchFiles",
      ],
      promptSectionIds: [
        "agent_identity",
        "output_format",
        "action_protocol",
        "action_decision_rules",
        "tool_catalog",
        "permission_safety",
        "patch_workflow",
        "stop_protocol",
        "safe_output_boundary",
      ],
    });
    expect(request.messages.map((message) => message.content).join("\n"))
      .not.toContain("D:/projects/agent-anything");
  });

  it("builds a Helarc provider request from shell-enabled tool catalog metadata", () => {
    const request = buildHelarcProviderRequest(createPlannerInput({
      metadata: {
        [HELARC_TOOL_CATALOG_METADATA_KEY]: createHelarcToolCatalogMetadata({
          mode: "shell-enabled",
          tools: [
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
            {
              name: "codeAgent.runCommand",
              description: "Run a process inside a declared task workspace root.",
              risk: "risky",
            },
          ],
        }),
      },
    }));

    expect(request.metadata.exposedToolNames).toEqual([
      "codeAgent.listFiles",
      "codeAgent.readFile",
      "codeAgent.searchFiles",
      "codeAgent.runCommand",
    ]);
    expect(request.messages[0]?.content).toContain("Active tool catalog (shell-enabled):");
    expect(request.messages[0]?.content).toContain("codeAgent.runCommand");
    expect(request.messages[0]?.content).toContain("Risk: risky");
    expect(request.messages[0]?.content).toContain("Requires policy and permission approval");
  });

  it("assembles Helarc prompts from named sections", () => {
    const assembly = buildHelarcPromptAssembly({
      plannerInput: createPlannerInput(),
    });

    expect(assembly.versions).toEqual({
      promptArchitectureVersion: "helarc-prompt-v1",
      actionContractVersion: "helarc-action-v1",
      toolCatalogVersion: "helarc-tool-catalog-v1",
    });
    expect(assembly.systemSections.map((section) => section.id)).toEqual([
      "agent_identity",
      "output_format",
      "action_protocol",
      "action_decision_rules",
      "tool_catalog",
      "permission_safety",
      "patch_workflow",
      "stop_protocol",
      "safe_output_boundary",
    ]);
    expect(assembly.systemPrompt).toContain("You are Helarc, a careful code agent planner.");
    expect(assembly.systemPrompt).toContain("For propose, return action, summary");
    expect(assembly.systemPrompt).toContain("Use propose for file creation, update, or deletion.");
    expect(assembly.systemPrompt).toContain("Use call_tool only for tools listed in the active tool catalog.");
    expect(assembly.systemPrompt).toContain("Active tool catalog (read-only):");
    expect(assembly.systemPrompt).toContain("File creation, update, and deletion are not tool calls in read-only mode; use propose.");
    expect(assembly.exposedToolNames).toEqual([
      "codeAgent.listFiles",
      "codeAgent.readFile",
      "codeAgent.searchFiles",
    ]);
    expect(assembly.userPrompt).toContain("Task:\nUpdate docs");
  });

  it("generates read-only and shell-enabled tool catalog text", () => {
    const readOnlyCatalog = createHelarcToolCatalogFromDefinitions({
      mode: "read-only",
      tools: [
        { name: "codeAgent.listFiles", description: "List files.", risk: "safe" },
        { name: "codeAgent.readFile", description: "Read files.", risk: "safe" },
        { name: "codeAgent.searchFiles", description: "Search files.", risk: "safe" },
      ],
    });
    const shellCatalog = createHelarcToolCatalogFromDefinitions({
      mode: "shell-enabled",
      tools: [
        ...readOnlyCatalog.tools,
        { name: "codeAgent.runCommand", description: "Run commands.", risk: "risky" },
      ],
    });

    expect(buildHelarcToolCatalogText(readOnlyCatalog)).toContain("Active tool catalog (read-only):");
    expect(readOnlyCatalog.tools.map((tool) => tool.name)).toEqual([
      "codeAgent.listFiles",
      "codeAgent.readFile",
      "codeAgent.searchFiles",
    ]);
    expect(buildHelarcToolCatalogText(readOnlyCatalog))
      .toContain("File creation, update, and deletion are not tool calls in read-only mode; use propose.");
    expect(shellCatalog.tools.map((tool) => tool.name)).toEqual([
      "codeAgent.listFiles",
      "codeAgent.readFile",
      "codeAgent.searchFiles",
      "codeAgent.runCommand",
    ]);
    expect(buildHelarcToolCatalogText(shellCatalog)).toContain("codeAgent.runCommand");
    expect(buildHelarcToolCatalogText(shellCatalog)).toContain("Risk: risky");
    expect(buildHelarcToolCatalogText(shellCatalog)).toContain("Use codeAgent.runCommand only when command execution is necessary");
  });

  it("generates action protocol and decision rules from the action contract", () => {
    const contract = createHelarcActionContract();
    const actionProtocol = buildHelarcActionProtocolText(contract);
    const decisionRules = buildHelarcActionDecisionRulesText(contract);

    expect(contract.actions.map((item) => item.action)).toEqual([
      "call_tool",
      "complete",
      "propose",
      "stop",
    ]);
    expect(actionProtocol).toContain("Use one of these actions: call_tool, complete, propose, stop.");
    expect(actionProtocol).toContain("For call_tool, return action, toolName, input, and optional reason, toolCallId.");
    expect(actionProtocol).toContain("For propose, return action, summary, change.");
    expect(decisionRules).toContain("Use propose for file creation, update, or deletion.");
    expect(decisionRules).toContain("Use call_tool only for tools listed in the active tool catalog.");
    expect(decisionRules).toContain("Do not use shell unless the host explicitly exposes shell in the active tool catalog.");
  });

  it("parses call_tool output into a tool plan step", () => {
    const step = parseHelarcProviderResponse(response({
      action: "call_tool",
      reason: "Need to inspect files.",
      toolName: "codeAgent.listFiles",
      input: { path: "." },
      toolCallId: "tool-1",
    }), createPlannerInput());

    expect(step).toMatchObject({
      kind: "callTool",
      reason: "Need to inspect files.",
      toolCall: {
        id: "tool-1",
        toolName: "codeAgent.listFiles",
        input: { path: "." },
        risk: "safe",
      },
    });
  });

  it("parses complete output into a final plan step", () => {
    const step = parseHelarcProviderResponse(response({
      action: "complete",
      summary: "No changes needed.",
    }), createPlannerInput());

    expect(step).toMatchObject({
      kind: "final",
      reason: "No changes needed.",
      finalOutput: {
        kind: "complete",
        summary: "No changes needed.",
      },
    });
  });

  it("parses proposed change output into a final plan step", () => {
    const step = parseHelarcProviderResponse(response(JSON.stringify({
      action: "propose",
      summary: "Update README.",
      change: {
        operation: "update",
        path: "README.md",
        content: "# Updated\n",
      },
    })), createPlannerInput());

    expect(step).toMatchObject({
      kind: "final",
      finalOutput: {
        kind: "propose",
        summary: "Update README.",
        change: {
          operation: "update",
          path: "README.md",
          content: "# Updated\n",
        },
      },
    });
  });

  it("parses stop output into a stop plan step", () => {
    const step = parseHelarcProviderResponse(response({
      action: "stop",
      reason: "Task is unsafe.",
    }), createPlannerInput());

    expect(step).toMatchObject({
      kind: "stop",
      stopReason: "Task is unsafe.",
    });
  });

  it("rejects malformed structured output", () => {
    expect(() => parseStructuredOutput({ action: "propose", summary: "Missing change" }))
      .toThrowError(new HelarcPlannerParseError(
        "planner_change_required",
        "Proposed output requires a change object.",
      ));
  });

  it("rejects provider failures with a stable planner code", () => {
    expectPlannerParseError(() => parseHelarcProviderResponse({
      status: "failed",
      output: null,
      usage: null,
      error: {
        code: "provider_network_timeout",
        message: "Provider failed.",
      },
      metadata: {},
    }, createPlannerInput()), "provider_failed");
  });

  it("rejects invalid planner output with stable codes", () => {
    const oversizedOutput = JSON.stringify({ action: "complete", summary: "x" })
      .padEnd(HELARC_PLANNER_OUTPUT_MAX_LENGTH + 1, " ");

    const cases: Array<[string, () => void, string]> = [
      ["oversized output", () => parseStructuredOutput(oversizedOutput), "planner_output_too_large"],
      ["non-json output", () => parseStructuredOutput("{"), "planner_output_not_json"],
      ["non-object output", () => parseStructuredOutput([]), "planner_output_invalid"],
      ["unsupported action", () => parseStructuredOutput({ action: "unknown" }), "planner_action_invalid"],
      ["missing tool name", () => parseStructuredOutput({ action: "call_tool", input: {} }), "planner_tool_name_required"],
      [
        "missing tool input",
        () => parseStructuredOutput({ action: "call_tool", toolName: "codeAgent.listFiles" }),
        "planner_tool_input_required",
      ],
      [
        "invalid tool input",
        () => parseStructuredOutput({ action: "call_tool", toolName: "codeAgent.listFiles", input: [] }),
        "planner_tool_input_invalid",
      ],
      ["missing summary", () => parseStructuredOutput({ action: "complete" }), "planner_summary_required"],
      [
        "missing change",
        () => parseStructuredOutput({ action: "propose", summary: "Missing change" }),
        "planner_change_required",
      ],
      [
        "missing operation",
        () => parseStructuredOutput({ action: "propose", summary: "Bad change", change: { path: "README.md" } }),
        "planner_change_operation_required",
      ],
      [
        "invalid operation",
        () => parseStructuredOutput({
          action: "propose",
          summary: "Bad change",
          change: { operation: "rename", path: "README.md" },
        }),
        "planner_change_operation_invalid",
      ],
      [
        "missing path",
        () => parseStructuredOutput({ action: "propose", summary: "Bad change", change: { operation: "delete" } }),
        "planner_change_path_required",
      ],
      [
        "missing content",
        () => parseStructuredOutput({ action: "propose", summary: "Bad change", change: { operation: "create", path: "a.txt" } }),
        "planner_change_content_required",
      ],
      ["missing stop reason", () => parseStructuredOutput({ action: "stop" }), "planner_stop_reason_required"],
    ];

    for (const [name, execute, code] of cases) {
      expectPlannerParseError(execute, code, name);
    }
  });

  it("rejects tool calls outside the active tool catalog before execution", () => {
    expectPlannerParseError(() => parseHelarcProviderResponse(response({
      action: "call_tool",
      toolName: "codeAgent.runCommand",
      input: { command: "echo hello" },
    }), createPlannerInput()), "planner_tool_name_unsupported");
  });

  it("accepts shell tool calls only when shell is exposed by the active tool catalog", () => {
    const step = parseHelarcProviderResponse(response({
      action: "call_tool",
      toolName: "codeAgent.runCommand",
      input: { command: "echo hello" },
    }), createPlannerInput({
      metadata: {
        [HELARC_TOOL_CATALOG_METADATA_KEY]: createHelarcToolCatalogMetadata({
          mode: "shell-enabled",
          tools: [
            {
              name: "codeAgent.runCommand",
              description: "Run a process inside a declared task workspace root.",
              risk: "risky",
            },
          ],
        }),
      },
    }));

    expect(step).toMatchObject({
      kind: "callTool",
      toolCall: {
        toolName: "codeAgent.runCommand",
        input: { command: "echo hello" },
        risk: "risky",
      },
    });
  });

  it("can drive ProviderBackedPlanner with an injected fake provider", async () => {
    const provider = new FakeProvider(response({
      action: "complete",
      summary: "Finished.",
    }));
    const planner = new ProviderBackedPlanner({
      provider,
      buildRequest: buildHelarcProviderRequest,
      parseResponse: parseHelarcProviderResponse,
    });

    const step = await planner.plan(createPlannerInput());

    expect(provider.lastRequest?.capability).toBe("helarc.code-agent.plan");
    expect(step).toMatchObject({
      kind: "final",
      finalOutput: { kind: "complete", summary: "Finished." },
    });
  });
});

class FakeProvider implements Provider {
  readonly descriptor = {
    id: "fake-helarc-provider",
    name: "Fake Helarc Provider",
    capabilities: {
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: false,
    },
    metadata: {},
  };
  lastRequest: ProviderRequest | null = null;

  constructor(private readonly providerResponse: ProviderResponse) {}

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    this.lastRequest = request;
    return this.providerResponse;
  }
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

function createPlannerInput(input: {
  metadata?: PlannerInput["metadata"];
} = {}): PlannerInput {
  return {
    task: {
      id: "task-1",
      kind: "helarc.code-task",
      input: { prompt: "Update docs" },
      createdAt: "2026-06-27T00:00:00.000Z",
      metadata: {},
    },
    context: {
      taskId: "task-1",
      messages: [],
      observations: [],
      evidenceRefs: [],
      metadata: {},
    },
    metadata: input.metadata ?? {},
  };
}

function expectPlannerParseError(
  execute: () => unknown,
  code: string,
  label = code,
): void {
  try {
    execute();
  } catch (error) {
    expect(error, label).toBeInstanceOf(HelarcPlannerParseError);
    expect((error as HelarcPlannerParseError).code, label).toBe(code);
    return;
  }

  throw new Error(`Expected HelarcPlannerParseError: ${label}`);
}
