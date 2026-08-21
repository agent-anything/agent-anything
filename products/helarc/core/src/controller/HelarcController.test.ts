import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import {
  ProviderBackedController,
  StructuredOutputError,
  type ControllerCallContext,
  type ControllerInput,
} from "@agent-anything/agent-runtime/controller";
import { createSystemRetryExecutor, systemRetryClock } from "@agent-anything/agent-runtime/retry";
import { createRunCancellationController } from "@agent-anything/agent-runtime/run";
import type {
  Provider,
  ProviderCallResult,
  ProviderRequest,
  ProviderResponse,
} from "@agent-anything/model-interaction";
import { createUtf8ModelInputAccounting } from "@agent-anything/model-interaction/input";
import { createToolCatalogSnapshot, type ToolDescriptorInput } from "@agent-anything/tools/catalog";
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
import { buildHelarcPromptAssembly, HELARC_ACTION_CONTRACT_VERSION } from "../prompt/index.js";
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
  renderFraming: (sections) => JSON.stringify({ roles: sections.map(({ role }) => role) }),
});

describe("Helarc controller", () => {
  it("builds a request with the accepted decision and Tool Contracts", () => {
    const request = buildHelarcProviderRequest(createControllerInput(), {
      attemptNumber: 1,
      correction: null,
      inputAccounting: TEST_INPUT_ACCOUNTING,
    });

    expect(request.metadata).toMatchObject({
      runId: "run-1",
      promptArchitectureVersion: "helarc-prompt-v3",
      actionContractVersion: "helarc-model-decision-v1",
      toolCatalogVersion: "helarc-tool-catalog-v3",
      exposedToolNames: ["Read", "Glob", "Grep", "Edit", "Write"],
    });
    const prompt = request.messages.map(({ content }) => content).join("\n");
    expect(prompt).toContain("tool_call, plan_update, completion, stop");
    expect(prompt).toContain("A successful Edit or Write is an Observation");
    expect(prompt).toContain('"file_path"');
    expect(prompt).toContain("Task:\nUpdate docs");
    expect(prompt).not.toContain("D:/projects/agent-anything");
    expect(request.composition.lineage).toMatchObject({
      contextProjection: { id: "projection-1" },
      projectionManifest: { id: "manifest-1" },
      toolExposure: { id: "tool-exposure-1" },
    });
  });

  it("assembles the four-decision model Contract without a proposal workflow", () => {
    const assembly = buildHelarcPromptAssembly({
      controllerInput: createControllerInput(),
      correctionMessage: null,
    });
    const contract = createHelarcActionContract();

    expect(assembly.promptSections.filter(({ role }) => role === "system").map(({ id }) => id))
      .toEqual([
        "agent_identity",
        "output_format",
        "action_protocol",
        "action_decision_rules",
        "tool_catalog",
        "permission_safety",
        "stop_protocol",
        "safe_output_boundary",
      ]);
    expect(contract.decisions.map(({ kind }) => kind)).toEqual([
      "tool_call",
      "plan_update",
      "completion",
      "stop",
    ]);
    expect(buildHelarcActionProtocolText(contract))
      .toContain("For tool_call, return kind, toolName, input, and optional reason.");
    expect(buildHelarcActionDecisionRulesText(contract))
      .toContain("Use plan_update only when an explicit plan improves the current work");
  });

  it("builds bounded correction diagnostics", () => {
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
      structuredOutputCorrectionCode: "controller_output_not_json",
    });
    expect(request.messages.at(-1)).toMatchObject({
      role: "user",
      metadata: { kind: "structured-output-correction" },
    });
  });

  it("maps one Tool decision to one model-origin Operation request", () => {
    const decision = parseHelarcProviderResponse(response({
      kind: "tool_call",
      toolName: "Read",
      input: { file_path: "src/index.ts" },
      reason: "Inspect the current file.",
    }), createControllerInput());
    expect(decision).toMatchObject({
      kind: "advance",
      candidates: [{
        kind: "operation_request",
        origin: "tool_request",
        tool: {
          name: "Read",
          input: { file_path: "src/index.ts" },
          origin: "model",
          controllerRequestId: "controller-request-1",
        },
      }],
      modelItems: [{
        metadata: { controllerAction: "tool_call", requestedToolName: "Read" },
      }],
    });
  });

  it("maps a Plan update to one Runner-owned state transition", () => {
    expect(parseHelarcProviderResponse(response({
      kind: "plan_update",
      explanation: "The task has multiple steps.",
      plan: [
        { step: "Inspect files", status: "in_progress" },
        { step: "Apply exact change", status: "pending" },
      ],
    }), createControllerInput())).toMatchObject({
      kind: "advance",
      candidates: [{
        kind: "state_transition",
        transition: "plan_update",
        input: {
          explanation: "The task has multiple steps.",
          plan: [
            { step: "Inspect files", status: "in_progress" },
            { step: "Apply exact change", status: "pending" },
          ],
        },
      }],
    });
  });

  it.each([
    [
      { kind: "completion", summary: "The task is complete." },
      { kind: "propose_completion", output: { kind: "complete", summary: "The task is complete." } },
    ],
    [
      { kind: "stop", reason: "Cannot continue safely." },
      { kind: "propose_stop", reason: "Cannot continue safely." },
    ],
  ])("maps terminal provider decision %#", (output, expected) => {
    expect(parseHelarcProviderResponse(response(output), createControllerInput()))
      .toMatchObject(expected);
  });

  it.each<[string, unknown, HelarcControllerParseErrorCode]>([
    ["invalid JSON", "{", "controller_output_not_json"],
    ["legacy action shape", { action: "complete", summary: "Done." }, "model_decision_field_invalid"],
    ["unsupported decision", { kind: "propose", summary: "Change it." }, "model_decision_kind_invalid"],
    ["missing Tool input", { kind: "tool_call", toolName: "Read" }, "model_decision_tool_input_invalid"],
    ["non-object Tool input", { kind: "tool_call", toolName: "Read", input: [] }, "model_decision_tool_input_invalid"],
    ["empty summary", { kind: "completion", summary: "" }, "model_decision_field_invalid"],
  ])("rejects %s", (_label, output, code) => {
    expectParseError(() => parseStructuredOutput(output), code);
  });

  it("classifies invalid JSON for structured-output correction", () => {
    try {
      parseStructuredOutput("{");
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredOutputError);
      expect((error as StructuredOutputError).failure.category).toBe("structured_output_syntax");
      return;
    }
    throw new Error("Expected StructuredOutputError.");
  });

  it("rejects Tools outside the active catalog", () => {
    expectParseError(() => parseHelarcProviderResponse(response({
      kind: "tool_call",
      toolName: "RunCommand",
      input: { command: "npm test" },
    }), createControllerInput()), "controller_tool_name_unsupported");
  });

  it("rejects oversized string output", () => {
    const output = JSON.stringify({ kind: "completion", summary: "done" })
      .padEnd(HELARC_CONTROLLER_OUTPUT_MAX_LENGTH + 1, " ");
    expectParseError(() => parseStructuredOutput(output), "controller_output_too_large");
  });

  it("drives ProviderBackedController with the accepted adapters", async () => {
    const provider = new FakeProvider({ kind: "completion", summary: "Done." });
    const controller = new ProviderBackedController<HelarcAgentOutput>({
      provider,
      buildRequest: buildHelarcProviderRequest,
      parseResponse: parseHelarcProviderResponse,
      structuredOutputContractId: HELARC_ACTION_CONTRACT_VERSION,
      maxProviderOutputLength: HELARC_CONTROLLER_OUTPUT_MAX_LENGTH,
      retryExecutor: createSystemRetryExecutor(),
      retryClock: systemRetryClock,
    });
    expect(await controller.next(createControllerInput(), controllerCallContext()))
      .toMatchObject({ kind: "propose_completion", output: { summary: "Done." } });
    expect(provider.requests).toHaveLength(1);
  });
});

const FILE_TOOLS = [
  tool("Read", true),
  tool("Glob", true),
  tool("Grep", true),
  tool("Edit", false),
  tool("Write", false),
];

function createControllerInput(): ControllerInput<HelarcAgentOutput> {
  return {
    runId: "run-1",
    iteration: 1,
    agent: {
      id: "helarc",
      revision: "1",
      name: "Helarc",
      instructions: "Complete the code task.",
      output: { validate: (candidate) => ({ valid: true, output: candidate as HelarcAgentOutput }) },
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
    toolExposure: createToolExposure(FILE_TOOLS),
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
      accounting: { unit: "bytes", consideredItems: 0, projectedItems: 0, projectedAmount: 0 },
    },
    plan: null,
    permission: {
      profile: {
        profileId: "test-profile",
        sourceProfileIds: ["test-profile"],
        environmentId: "test-environment",
        enforcement: "enforced",
        workspaceRootCount: 1,
        fileSystem: { unrestricted: false, allowsRead: true, allowsWrite: false, hasDenials: false, managed: false },
        process: { unrestricted: false },
        network: { enabled: false, profileRestricted: false, managedRestricted: false, hasDenials: false },
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
      approval: { canRequest: true, reviewer: "user", pendingCount: 0 },
    },
    pending: [],
    workspace: {
      primary: { id: "workspace-1", name: "Workspace", rootRef: "workspace://root", trustState: "trusted", source: "test", policyRefs: [], metadata: {} },
      additional: [],
    },
    identity: { id: "identity-1", kind: "anonymous", displayName: "Test identity", metadata: {} },
    metadata: {
      [HELARC_TOOL_CATALOG_METADATA_KEY]: createHelarcToolCatalogMetadata(),
    },
  };
}

function tool(name: string, readOnly: boolean): ToolDescriptorInput {
  const operationName = name.toLowerCase();
  return {
    ref: { tool: { namespace: "helarc.code-agent", name: operationName }, revision: "2" },
    name,
    description: `${name} a Workspace file.`,
    inputSchema: name === "Read"
      ? { type: "object", additionalProperties: false, required: ["file_path"], properties: { file_path: { type: "string" } } }
      : {},
    schemaRevisions: { dialect: "json-schema-2020-12", input: "2", output: "2", translation: "native-2" },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly },
    source: { kind: "product", sourceId: "helarc.code-agent", sourceRevision: "2", activationEpoch: null },
    operationBinding: {
      operation: { operation: { namespace: "helarc.code-agent.file", name: operationName }, revision: "2" },
      revision: "2",
    },
    metadata: {},
  };
}

function createToolExposure(tools: readonly ToolDescriptorInput[]): ToolExposureProof {
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

function controllerCallContext(): ControllerCallContext {
  const policy = {
    maxRetries: 0,
    delay: { kind: "exponential_jitter" as const, baseDelayMs: 0, maxDelayMs: 0, multiplier: 2 as const, jitterRatio: 0.1 as const },
    retryableCategories: [] as string[],
    serverDelay: { mode: "ignore" as const },
  };
  return {
    cancellation: createRunCancellationController({ runId: "run-1" }).context,
    retry: { providerRequest: policy, structuredOutput: policy, deadlineAt: "2099-01-01T00:00:00.000Z", events: { emit() {} } },
  };
}

function response(output: unknown): ProviderResponse {
  return { output, usage: null, metadata: {} };
}

function expectParseError(action: () => unknown, code: HelarcControllerParseErrorCode): void {
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

  async send(request: ProviderRequest, _context: InvocationInterruptionContext): Promise<ProviderCallResult> {
    this.requests.push(request);
    return { kind: "succeeded", response: response(this.output) };
  }
}
