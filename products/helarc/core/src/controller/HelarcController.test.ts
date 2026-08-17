import { ProviderBackedController, StructuredOutputError } from "@agent-anything/agent-runtime/controller";
import { createSystemRetryExecutor, systemRetryClock } from "@agent-anything/agent-runtime/retry";
import type { ControllerCallContext, ControllerInput } from "@agent-anything/agent-runtime/controller";
import { createRunCancellationController } from "@agent-anything/agent-runtime/run";
import type {
  Provider,
  ProviderCallResult,
  ProviderRequest,
  ProviderResponse,
} from "@agent-anything/model-interaction";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { createUtf8ModelInputAccounting } from "@agent-anything/model-interaction/input";
import {
  createToolCatalogSnapshot,
  type ToolDescriptorInput,
} from "@agent-anything/tools/catalog";
import type { ToolExposureProof } from "@agent-anything/tools/selection";
import { describe, expect, it } from "vitest";
import {
  buildHelarcActionDecisionRulesText,
  buildHelarcActionProtocolText,
  buildHelarcProviderRequest,
  createHelarcActionContract,
  HELARC_CONTROLLER_OUTPUT_MAX_LENGTH,
  HelarcControllerParseError,
  parseHelarcProviderResponse,
  parseStructuredOutput,
  type HelarcAgentOutput,
  type HelarcControllerParseErrorCode,
} from "./index.js";
import {
  buildHelarcPromptAssembly,
  HELARC_ACTION_CONTRACT_VERSION,
} from "../prompt/index.js";
import {
  createHelarcToolCatalogMetadata,
  HELARC_TOOL_CATALOG_METADATA_KEY,
} from "../tools/index.js";

const TEST_INPUT_ACCOUNTING = createUtf8ModelInputAccounting({
  providerId: "fake-provider",
  model: "helarc-controller-test-model",
  maximumInputBytes: 4 * 1_024 * 1_024,
  limitSource: "host_configured",
  estimator: { id: "fake-provider.utf8-content", revision: "1" },
  framing: { id: "fake-provider.framing", revision: "1" },
  renderFraming: (sections) => JSON.stringify({
    roles: sections.map((section) => section.role),
  }),
});

describe("Helarc controller", () => {
  it("builds a provider request from the current Runner state", () => {
    const request = buildHelarcProviderRequest(createControllerInput(), {
      attemptNumber: 1,
      correction: null,
      inputAccounting: TEST_INPUT_ACCOUNTING,
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
    const completeInput = request.messages.map((message) => message.content).join("\n");
    expect(completeInput).toContain("You are Helarc, a careful code agent.");
    expect(completeInput).toContain("update_plan");
    expect(completeInput).toContain("Task:\nUpdate docs");
    expect(completeInput).toContain("Current plan:");
    expect(completeInput)
      .not.toContain("D:/projects/agent-anything");
    expect(request.composition.lineage).toMatchObject({
      contextProjection: { id: "projection-1" },
      projectionManifest: { id: "manifest-1" },
      toolExposure: { id: "tool-exposure-1" },
    });
  });

  it("assembles named prompt sections and an explicit action contract", () => {
    const assembly = buildHelarcPromptAssembly({
      controllerInput: createControllerInput(),
      correctionMessage: null,
    });
    const contract = createHelarcActionContract();

    expect(assembly.promptSections
      .filter((section) => section.role === "system")
      .map((section) => section.id)).toEqual([
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
      inputAccounting: TEST_INPUT_ACCOUNTING,
    });

    expect(request.metadata.exposedToolNames).toContain("codeAgent.runCommand");
    const completeInput = request.messages.map((message) => message.content).join("\n");
    expect(completeInput).toContain("Active tool catalog (shell-enabled):");
    expect(completeInput).toContain(
      "Assessed from the exact process action and current run authority",
    );
  });

  it("builds bounded correction diagnostics without copying rejected output", () => {
    const rejectedOutput = "private rejected provider output";
    const request = buildHelarcProviderRequest(createControllerInput(), {
      attemptNumber: 2,
      inputAccounting: TEST_INPUT_ACCOUNTING,
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
      kind: "advance",
      candidates: [{
        kind: "operation_request",
        origin: "tool_request",
        tool: {
          name: "codeAgent.listFiles",
          input: { path: "." },
          origin: "model",
          controllerRequestId: "controller-request-1",
        },
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
    expect(decision.kind === "advance" ? decision.candidates[0] : {}).not.toHaveProperty("id");
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
      kind: "advance",
      candidates: [{
        kind: "state_transition",
        transition: "plan_update",
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
      kind: "advance",
      candidates: [{
        kind: "interaction_request",
        protocol: {
          owner: "helarc",
          kind: "permission_request",
          revision: "1",
        },
        subject: {
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
      { kind: "propose_completion", output: { kind: "complete", summary: "No change is needed." } },
    ],
    [
      {
        action: "propose",
        summary: "Create empty.txt.",
        change: { operation: "create", path: "empty.txt", content: "" },
      },
      {
        kind: "propose_completion",
        output: {
          kind: "propose",
          summary: "Create empty.txt.",
          change: { operation: "create", path: "empty.txt", content: "" },
        },
      },
    ],
    [
      { action: "stop", reason: "Cannot continue safely." },
      { kind: "propose_stop", reason: "Cannot continue safely." },
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
      kind: "propose_completion",
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
  tools?: ToolDescriptorInput[];
  mode?: "read-only" | "shell-enabled";
} = {}): ControllerInput<HelarcAgentOutput> {
  const tools = input.tools ?? READ_ONLY_TOOLS;
  return {
    runId: "run-1",
    iteration: 1,
    agent: {
      id: "helarc",
      revision: "1",
      name: "Helarc",
      instructions: "Complete the code task.",
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
    inputItems: [],
    toolExposure: createToolExposure(tools),
    context: {
      id: "projection-1",
      requestId: "projection-request-1",
      activeContext: { id: "context-1", runId: "run-1", version: 1 },
      estimator: { id: "utf8-bytes", revision: "1", unit: "bytes", accuracy: "exact" },
      blocks: [],
      accounting: { unit: "bytes", amount: 0 },
      manifestId: "manifest-1",
      createdAt: "2026-07-08T00:00:00.000Z",
    },
    contextManifest: {
      id: "manifest-1",
      projectionId: "projection-1",
      requestId: "projection-request-1",
      activeContext: { id: "context-1", runId: "run-1", version: 1 },
      profile: { id: "helarc-controller-context", revision: "1" },
      policy: { id: "helarc-context-policy", revision: "1" },
      estimator: { id: "utf8-bytes", revision: "1", unit: "bytes", accuracy: "exact" },
      budget: { unit: "bytes", maximum: 256 * 1_024 },
      accounting: {
        unit: "bytes",
        consideredItems: 0,
        projectedItems: 0,
        projectedAmount: 0,
      },
    },
    plan: null,
    permission: {
      profile: {
        profileId: "test-profile",
        sourceProfileIds: ["test-profile"],
        environmentId: "test-environment",
        enforcement: "enforced",
        workspaceRootCount: 1,
        fileSystem: {
          unrestricted: false,
          allowsRead: true,
          allowsWrite: false,
          hasDenials: false,
          managed: false,
        },
        process: { unrestricted: false },
        network: {
          enabled: false,
          profileRestricted: false,
          managedRestricted: false,
          hasDenials: false,
        },
        managedConstraintSetId: "test-constraints",
        canRequestAdditionalPermissions: true,
      },
      authority: {
        hasAdditionalFileSystemRead: false,
        hasAdditionalFileSystemWrite: false,
        hasAdditionalNetwork: false,
        actionCoverageCount: 0,
        runGrantCount: 0,
        sessionAuthorityCount: 0,
        policyAmendmentCount: 0,
      },
      approval: {
        canRequest: true,
        reviewer: "user",
        pendingCount: 0,
      },
    },
    pending: [],
    workspace: {
      primary: {
        id: "workspace-1",
        name: "Workspace",
        rootRef: "workspace://root",
        trustState: "trusted",
        source: "test",
        policyRefs: [],
        metadata: {},
      },
      additional: [],
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
      }),
    },
  };
}

function tool(
  name: string,
  description: string,
  risk: "safe" | "risky",
): ToolDescriptorInput {
  const operationName = name.replace(/^codeAgent\./, "");
  return {
    ref: {
      tool: { namespace: "helarc.code-agent", name: operationName },
      revision: "1",
    },
    name,
    description,
    inputSchema: {},
    schemaRevisions: {
      dialect: "json-schema-2020-12",
      input: "1",
      output: null,
      translation: "1",
    },
    annotations: {
      readOnlyHint: risk === "safe",
      destructiveHint: risk === "risky",
    },
    source: {
      kind: "product",
      sourceId: "helarc",
      sourceRevision: "1",
      activationEpoch: null,
    },
    operationBinding: {
      operation: {
        operation: { namespace: "helarc.code-agent", name: operationName },
        revision: "1",
      },
      revision: "1",
    },
    metadata: {},
  };
}

function createToolExposure(
  tools: readonly ToolDescriptorInput[],
): ToolExposureProof {
  const catalog = createToolCatalogSnapshot(tools);
  return Object.freeze({
    id: "tool-exposure-1",
    selectionRevision: "tool-selection-1",
    consumer: "controller" as const,
    controllerRequestId: "controller-request-1",
    exposedTools: Object.freeze(catalog.tools.map(({ ref }) => ref)),
    catalog,
  });
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
  readonly inputAccounting = TEST_INPUT_ACCOUNTING;
  readonly descriptor = {
    id: "fake-provider",
    name: "Fake provider",
    capabilities: {
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: false,
      modelInput: this.inputAccounting.capability,
      continuation: { supported: false as const },
    },
    requestRetryScheduler: { kind: "harness" as const },
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
