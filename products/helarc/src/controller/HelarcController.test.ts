import {
  ProviderBackedController,
  StructuredOutputError,
  createSystemRetryExecutor,
  systemRetryClock,
} from "@agent-anything/agent-runtime";
import {
  createRunCancellationController,
  type ControllerCallContext,
  type ControllerInput,
} from "@agent-anything/agent-core";
import type {
  InvocationInterruptionContext,
  Provider,
  ProviderCallResult,
  ProviderRequest,
  ProviderResponse,
} from "@agent-anything/providers";
import type { ToolDescriptor } from "@agent-anything/tools";
import { describe, expect, it } from "vitest";
import {
  buildHelarcActionDecisionRulesText,
  buildHelarcActionProtocolText,
  buildHelarcProviderRequest,
  buildHelarcPromptAssembly,
  createHelarcActionContract,
  createHelarcToolCatalogMetadata,
  HELARC_ACTION_CONTRACT_VERSION,
  HELARC_CONTROLLER_OUTPUT_MAX_LENGTH,
  HELARC_TOOL_CATALOG_METADATA_KEY,
  HelarcControllerParseError,
  parseHelarcProviderResponse,
  parseStructuredOutput,
  type HelarcAgentOutput,
  type HelarcControllerParseErrorCode,
} from "./index.js";

describe("Helarc controller", () => {
  it("builds a provider request from the current Runner state", () => {
    const request = buildHelarcProviderRequest(createControllerInput(), {
      attemptNumber: 1,
      correction: null,
    });

    expect(request.capability).toBe("helarc.code-agent.turn");
    expect(request.metadata).toMatchObject({
      runId: "run-1",
      controllerIteration: 1,
      exposedToolNames: [
        "codeAgent.listFiles",
        "codeAgent.readFile",
        "codeAgent.searchFiles",
      ],
    });
    expect(request.messages[0]?.content).toContain("You are Helarc, a careful code agent.");
    expect(request.messages[0]?.content).toContain("update_plan");
    expect(request.messages[1]?.content).toContain("Task:\nUpdate docs");
    expect(request.messages[1]?.content).toContain("Current plan:");
    expect(request.messages.map((message) => message.content).join("\n"))
      .not.toContain("D:/projects/agent-anything");
  });

  it("assembles named prompt sections and an explicit action contract", () => {
    const assembly = buildHelarcPromptAssembly({
      controllerInput: createControllerInput(),
    });
    const contract = createHelarcActionContract();

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
    expect(contract.actions.map((item) => item.action)).toEqual([
      "call_tool",
      "request_permissions",
      "update_plan",
      "complete",
      "propose",
      "stop",
    ]);
    expect(buildHelarcActionProtocolText(contract))
      .toContain("For call_tool, return action, toolName, input, and optional reason.");
    expect(buildHelarcActionProtocolText(contract))
      .toContain("For request_permissions, return action, rootId, permissions, reason.");
    expect(buildHelarcActionDecisionRulesText(contract))
      .toContain("Use update_plan only when an explicit plan improves multi-step execution");
  });

  it("uses the active shell-enabled tool catalog", () => {
    const input = createControllerInput({
      tools: [...READ_ONLY_TOOLS, tool("codeAgent.runCommand", "Run a command.", "risky")],
      mode: "shell-enabled",
    });
    const request = buildHelarcProviderRequest(input, {
      attemptNumber: 1,
      correction: null,
    });

    expect(request.metadata.exposedToolNames).toContain("codeAgent.runCommand");
    expect(request.messages[0]?.content).toContain("Active tool catalog (shell-enabled):");
    expect(request.messages[0]?.content).toContain(
      "Assessed from the exact process action and current run authority",
    );
  });

  it("builds bounded correction diagnostics without copying rejected output", () => {
    const rejectedOutput = "private rejected provider output";
    const request = buildHelarcProviderRequest(createControllerInput(), {
      attemptNumber: 2,
      correction: {
        previousAttemptNumber: 1,
        failure: {
          category: "structured_output_syntax",
          code: "controller_output_not_json",
          correctionFeedback: "Return one valid JSON object without markdown.",
        },
      },
    });

    expect(request.metadata).toMatchObject({
      structuredOutputAttemptNumber: 2,
      structuredOutputCorrectionCategory: "structured_output_syntax",
      structuredOutputCorrectionCode: "controller_output_not_json",
    });
    expect(request.messages.at(-1)).toMatchObject({
      role: "user",
      metadata: { kind: "structured-output-correction" },
    });
    expect(request.messages.at(-1)?.content).toContain(
      "Return one valid JSON object without markdown.",
    );
    expect(JSON.stringify(request)).not.toContain(rejectedOutput);
  });

  it("classifies known protocol errors as explicit correction failures", () => {
    try {
      parseStructuredOutput("{");
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredOutputError);
      expect((error as StructuredOutputError).failure).toEqual({
        category: "structured_output_syntax",
        code: "controller_output_not_json",
        correctionFeedback: "Return one valid JSON object without markdown or surrounding text.",
      });
      return;
    }
    throw new Error("Expected structured-output correction failure.");
  });

  it("maps call_tool to a tool action without accepting a model-owned action id", () => {
    const decision = parseHelarcProviderResponse(response({
      action: "call_tool",
      toolCallId: "model-owned-id",
      reason: "Inspect files.",
      toolName: "codeAgent.listFiles",
      input: { path: "." },
    }), createControllerInput());

    expect(decision).toMatchObject({
      kind: "actions",
      actions: [{
        kind: "tool",
        name: "codeAgent.listFiles",
        input: { path: "." },
        modelItemId: "run-1:model:1",
      }],
      modelItems: [{
        id: "run-1:model:1",
        kind: "assistant_action",
        metadata: {
          source: "helarc-controller",
          controllerAction: "call_tool",
          requestedToolName: "codeAgent.listFiles",
        },
      }],
    });
    expect(decision.kind === "actions" ? decision.actions[0] : {}).not.toHaveProperty("id");
  });

  it("maps update_plan to the Runner-owned internal action", () => {
    const decision = parseHelarcProviderResponse(response({
      action: "update_plan",
      explanation: "This task has multiple steps.",
      plan: [
        { step: "Inspect files", status: "in_progress" },
        { step: "Prepare change", status: "pending" },
      ],
    }), createControllerInput());

    expect(decision).toMatchObject({
      kind: "actions",
      actions: [{
        kind: "internal",
        name: "update_plan",
        input: {
          explanation: "This task has multiple steps.",
          plan: [
            { step: "Inspect files", status: "in_progress" },
            { step: "Prepare change", status: "pending" },
          ],
        },
      }],
    });
  });

  it("maps request_permissions to the Runner-owned permission Action", () => {
    const decision = parseHelarcProviderResponse(response({
      action: "request_permissions",
      rootId: "workspace",
      permissions: { fileSystem: { write: ["output.txt"] } },
      reason: "Write the requested output.",
    }), createControllerInput());

    expect(decision).toMatchObject({
      kind: "actions",
      actions: [{
        kind: "permission_request",
        name: "request_permissions",
        input: {
          rootId: "workspace",
          permissions: { fileSystem: { write: ["output.txt"] } },
          reason: "Write the requested output.",
        },
        modelItemId: "run-1:model:1",
      }],
    });
  });

  it.each([
    [
      { action: "complete", summary: "No change is needed." },
      { kind: "final_output", output: { kind: "complete", summary: "No change is needed." } },
    ],
    [
      {
        action: "propose",
        summary: "Create empty.txt.",
        change: { operation: "create", path: "empty.txt", content: "" },
      },
      {
        kind: "final_output",
        output: {
          kind: "propose",
          summary: "Create empty.txt.",
          change: { operation: "create", path: "empty.txt", content: "" },
        },
      },
    ],
    [
      { action: "stop", reason: "Cannot continue safely." },
      { kind: "stop", reason: "Cannot continue safely." },
    ],
  ])("maps terminal provider output %#", (output, expected) => {
    expect(parseHelarcProviderResponse(response(output), createControllerInput()))
      .toMatchObject(expected);
  });

  it.each<[
    string,
    unknown,
    HelarcControllerParseErrorCode,
  ]>([
    ["invalid JSON", "{", "controller_output_not_json"],
    ["unknown action", { action: "rename_file" }, "controller_action_invalid"],
    ["missing tool name", { action: "call_tool", input: {} }, "controller_tool_name_required"],
    ["missing tool input", { action: "call_tool", toolName: "codeAgent.readFile" }, "controller_tool_input_required"],
    ["non-object tool input", { action: "call_tool", toolName: "codeAgent.readFile", input: [] }, "controller_tool_input_invalid"],
    ["missing summary", { action: "complete" }, "controller_summary_required"],
    ["missing change", { action: "propose", summary: "Change it." }, "controller_change_required"],
    ["invalid operation", { action: "propose", summary: "Change it.", change: { operation: "move", path: "a" } }, "controller_change_operation_invalid"],
    ["missing create content", { action: "propose", summary: "Create it.", change: { operation: "create", path: "a" } }, "controller_change_content_required"],
    ["missing stop reason", { action: "stop" }, "controller_stop_reason_required"],
  ])("rejects %s", (_label, output, code) => {
    expectParseError(() => parseStructuredOutput(output), code);
  });

  it("rejects tools outside the active catalog", () => {
    expectParseError(() => parseHelarcProviderResponse(response({
      action: "call_tool",
      toolName: "codeAgent.runCommand",
      input: { command: "npm" },
    }), createControllerInput()), "controller_tool_name_unsupported");
  });

  it("rejects oversized string output", () => {
    const output = JSON.stringify({ action: "complete", summary: "done" })
      .padEnd(HELARC_CONTROLLER_OUTPUT_MAX_LENGTH + 1, " ");

    expectParseError(
      () => parseStructuredOutput(output),
      "controller_output_too_large",
    );
  });

  it("drives ProviderBackedController with Helarc request and response adapters", async () => {
    const provider = new FakeProvider({ action: "complete", summary: "Done." });
    const controller = new ProviderBackedController<HelarcAgentOutput>({
      provider,
      buildRequest: buildHelarcProviderRequest,
      parseResponse: parseHelarcProviderResponse,
      structuredOutputContractId: HELARC_ACTION_CONTRACT_VERSION,
      maxProviderOutputLength: HELARC_CONTROLLER_OUTPUT_MAX_LENGTH,
      retryExecutor: createSystemRetryExecutor(),
      retryClock: systemRetryClock,
    });

    const decision = await controller.next(createControllerInput(), controllerCallContext());

    expect(provider.requests).toHaveLength(1);
    expect(decision).toMatchObject({
      kind: "final_output",
      output: { kind: "complete", summary: "Done." },
    });
  });
});

const READ_ONLY_TOOLS = [
  tool("codeAgent.listFiles", "List files.", "safe"),
  tool("codeAgent.readFile", "Read a file.", "safe"),
  tool("codeAgent.searchFiles", "Search files.", "safe"),
];

function controllerCallContext(): ControllerCallContext {
  const policy = {
    maxRetries: 0,
    delay: {
      kind: "exponential_jitter" as const,
      baseDelayMs: 0,
      maxDelayMs: 0,
      multiplier: 2 as const,
      jitterRatio: 0.1 as const,
    },
    retryableCategories: [] as string[],
    serverDelay: { mode: "ignore" as const },
  };
  return {
    cancellation: createRunCancellationController({ runId: "run-1" }).context,
    retry: {
      providerRequest: policy,
      structuredOutput: policy,
      deadlineAt: "2099-01-01T00:00:00.000Z",
      events: { emit() {} },
    },
  };
}

function createControllerInput(input: {
  tools?: ToolDescriptor[];
  mode?: "read-only" | "shell-enabled";
} = {}): ControllerInput<HelarcAgentOutput> {
  const tools = input.tools ?? READ_ONLY_TOOLS;
  return {
    runId: "run-1",
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
      id: "task-1",
      kind: "helarc.code-task",
      input: { prompt: "Update docs" },
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
      id: "workspace-1",
      name: "Workspace",
      rootRef: "workspace://root",
      trustState: "trusted",
      source: "test",
      policyRefs: [],
      metadata: {},
    },
    identity: {
      id: "identity-1",
      kind: "anonymous",
      displayName: "Test identity",
      metadata: {},
    },
    metadata: {
      [HELARC_TOOL_CATALOG_METADATA_KEY]: createHelarcToolCatalogMetadata({
        mode: input.mode ?? "read-only",
        tools,
      }),
    },
  };
}

function tool(
  name: string,
  description: string,
  risk: "safe" | "risky",
): ToolDescriptor {
  return {
    name,
    description,
    inputSchema: {},
    annotations: {
      readOnlyHint: risk === "safe",
      destructiveHint: risk === "risky",
    },
    metadata: {},
  };
}

function response(output: unknown): ProviderResponse {
  return {
    output,
    usage: null,
    metadata: {},
  };
}

function expectParseError(
  action: () => unknown,
  code: HelarcControllerParseErrorCode,
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HelarcControllerParseError);
    expect((error as HelarcControllerParseError).code).toBe(code);
    return;
  }
  throw new Error(`Expected HelarcControllerParseError with code ${code}.`);
}

class FakeProvider implements Provider {
  readonly descriptor = {
    id: "fake-provider",
    name: "Fake provider",
    capabilities: {
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: false,
    },
    requestRetryScheduler: { kind: "platform" as const },
    metadata: {},
  };
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly output: unknown) {}

  async send(
    request: ProviderRequest,
    _context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    this.requests.push(request);
    return { kind: "succeeded", response: response(this.output) };
  }
}
