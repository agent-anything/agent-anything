import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { createAgentInstructions } from "@agent-anything/agent-core/agent";
import {
  ControllerError,
  ProviderBackedController,
  type ControllerCallContext,
  type ControllerInput,
} from "@agent-anything/agent-runtime/controller";
import { createAgentInstructionBinding } from "@agent-anything/agent-runtime/instructions";
import { createSystemRetryExecutor, systemRetryClock } from "@agent-anything/agent-runtime/retry";
import { createRunCancellationController } from "@agent-anything/agent-runtime/run";
import {
  createModelCallRef,
  type ModelAssistantContentBlock,
  type ModelJsonValue,
  type ModelTurnFinish,
  type Provider,
  type ProviderCallResult,
  type ProviderRequest,
  type ProviderResponse,
} from "@agent-anything/model-interaction";
import { createUtf8ModelInputAccounting } from "@agent-anything/model-interaction/input";
import { createToolCatalogSnapshot, type ToolDescriptorInput } from "@agent-anything/tools/catalog";
import { createToolContractIdentity } from "@agent-anything/tools/identity";
import type { ToolExposureProof } from "@agent-anything/tools/selection";
import { describe, expect, it } from "vitest";
import { buildHelarcPromptAssembly } from "../prompt/index.js";
import {
  buildHelarcProviderRequest as buildProviderRequest,
  createHelarcControllerProtocolComposition,
  createHelarcContextProjectionConfiguration,
  HELARC_CONTROLLER_CONTROL_GUIDANCE,
  parseHelarcProviderResponse as parseProviderResponse,
  type HelarcAgentOutput,
} from "./index.js";
import type { ResolvedHelarcToolGuidance } from "../tools/guidance/index.js";
import { createHelarcProviderProfile } from "../configuration/index.js";
import {
  resolveHelarcModelQualification,
} from "../composition/HelarcModelUseAdmission.js";

const TEST_INPUT_ACCOUNTING = createUtf8ModelInputAccounting({
  providerId: "fake-provider",
  model: "helarc-controller-test-model",
  maximumInputBytes: 4 * 1_024 * 1_024,
  limitSource: "host_configured",
  estimator: { id: "fake-provider.utf8-content", revision: "1" },
  framing: { id: "fake-provider.framing", revision: "1" },
  renderRequest: (messages, interaction) => JSON.stringify({ messages, interaction }),
});

function buildHelarcProviderRequest(
  input: ControllerInput<HelarcAgentOutput>,
  context: ReturnType<typeof requestBuildContext>,
) {
  const protocol = createTestControllerProtocol(input);
  return buildProviderRequest(
    input,
    context,
    protocol,
    createTestQualification(input, protocol),
  );
}

function parseHelarcProviderResponse(
  response: ProviderResponse,
  input: ControllerInput<HelarcAgentOutput>,
) {
  const protocol = createTestControllerProtocol(input);
  return parseProviderResponse(
    response,
    input,
    protocol,
    createTestQualification(input, protocol),
  );
}

function createTestQualification(
  input: ControllerInput<HelarcAgentOutput>,
  protocol: ReturnType<typeof createTestControllerProtocol>,
) {
  const profile = createHelarcProviderProfile({
    id: "test-provider",
    displayName: "Test Provider",
    baseUrl: "https://provider.local/v1",
    model: input.agent.instructions.model.modelId,
    timeoutMs: 30_000,
    credentialStatus: "empty_allowed",
    qualificationPolicy: "allow_experimental",
    isActive: true,
  });
  if (!profile.ok) throw new TypeError("Test Provider profile is invalid.");
  return resolveHelarcModelQualification({
    provider: testQualificationProvider(input),
    providerProfile: profile.profile,
    agent: input.agent,
    controllerProtocol: protocol,
  });
}

function testQualificationProvider(
  input: ControllerInput<HelarcAgentOutput>,
): Provider {
  const accounting = createUtf8ModelInputAccounting({
    providerId: input.agent.instructions.model.providerId,
    model: input.agent.instructions.model.modelId,
    maximumInputBytes: 4 * 1_024 * 1_024,
    limitSource: "host_configured",
    estimator: { id: "qualification-test.utf8", revision: "1" },
    framing: { id: "qualification-test.framing", revision: "1" },
    renderRequest: (messages, interaction) => JSON.stringify({ messages, interaction }),
  });
  return Object.freeze({
    descriptor: Object.freeze({
      id: input.agent.instructions.model.providerId,
      name: "Test Provider",
      capabilities: Object.freeze({
        nativeToolInteraction: Object.freeze({
          supported: true as const,
          callableDefinitions: true as const,
          modelCalls: true as const,
          resultMessages: true as const,
          multipleCalls: true,
          callCorrelation: "provider_supplied" as const,
        }),
        structuredGeneration: Object.freeze({ supported: true as const }),
        streaming: Object.freeze({ supported: false as const }),
        modelInput: accounting.capability,
        continuation: Object.freeze({ supported: false as const }),
        compaction: Object.freeze({ supported: false as const }),
      }),
      requestRetryScheduler: Object.freeze({ kind: "harness" as const }),
      metadata: Object.freeze({}),
    }),
    inputAccounting: accounting,
    async send() {
      throw new Error("Test qualification Provider does not send requests.");
    },
  });
}

function createHelarcModelCallableCatalog(input: {
  readonly toolExposure: ToolExposureProof;
  readonly planLimits: ControllerInput<HelarcAgentOutput>["planLimits"];
}) {
  const controllerInput = {
    ...createControllerInput(),
    toolExposure: input.toolExposure,
    planLimits: input.planLimits,
  };
  return createTestControllerProtocol(controllerInput).createCallableCatalog(
    input.toolExposure,
    input.planLimits,
  );
}

describe("Helarc native Tool controller", () => {
  it("builds one native request from the exact Tool exposure and Product controls", () => {
    const input = createControllerInput();
    const request = buildHelarcProviderRequest(input, requestBuildContext());

    expect(request.interaction.kind).toBe("native_tool_turn");
    if (request.interaction.kind !== "native_tool_turn") {
      throw new Error("Expected native Tool interaction.");
    }
    expect(request.interaction.callables.map(({ name }) => name)).toEqual(
      [...request.interaction.callables.map(({ name }) => name)].sort(),
    );
    expect(request.interaction.callables.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["stop", "update_plan"]),
    );
    expect(request.interaction.callables).toHaveLength(FILE_TOOLS.length + 2);
    expect(request.interaction.callables.every(({ name }) => /^[A-Za-z0-9_-]+$/u.test(name)))
      .toBe(true);
    expect(request.interaction.callables.some(({ name }) => name === "Read")).toBe(false);
    expect(request.metadata).toMatchObject({
      runId: "run-1",
      promptArchitectureVersion: "helarc-prompt-v6",
      toolExposureVersion: "trusted-tool-exposure-v1",
      exposedToolCount: FILE_TOOLS.length,
      interactionMessageCount: 0,
      controllerControlGuidanceRevision: HELARC_CONTROLLER_CONTROL_GUIDANCE.revision,
    });
    expect(request.composition.lineage).toMatchObject({
      instructionBinding: { id: input.instructionBinding.ref.id },
      toolGuidance: { kind: "tool_guidance_binding" },
      controllerControlGuidance: {
        id: "helarc.controller-control-guidance",
        revision: HELARC_CONTROLLER_CONTROL_GUIDANCE.revision,
      },
      callableDefinitions: {
        kind: "model_callable_definitions",
        revision: request.metadata.modelCallableDefinitionsDigest,
      },
      interactionHistory: null,
      protocol: { id: "helarc.provider-native-tool-interaction.v1" },
    });
    const readDefinition = request.interaction.callables.find(({ name }) =>
      name.startsWith("Read_")
    );
    expect(readDefinition?.description).toContain("complete test-only Read Tool definition");
    expect(readDefinition?.description).not.toBe("Read a Workspace file.");
    expect(request.composition.sections[0]).toMatchObject({
      id: "helarc:model-input:agent-instructions:behavior",
      role: "system",
      necessity: "mandatory",
      content: { text: "Complete the code task." },
    });
    const prompt = messageText(request.messages);
    expect(prompt).toContain("Use only callable definitions supplied with the current model request.");
    expect(prompt).toContain("Task:\nUpdate docs");
    expect(prompt).not.toContain("Return only JSON");
    expect(prompt).not.toContain("D:/projects/agent-anything");
    expect(JSON.stringify(request.metadata)).not.toContain("Complete the code task.");
  });

  it("creates a deterministic, disjoint catalog whose callable names retain exact bindings", () => {
    const input = createControllerInput();
    const first = createHelarcModelCallableCatalog({
      toolExposure: input.toolExposure,
      planLimits: input.planLimits,
    });
    const second = createHelarcModelCallableCatalog({
      toolExposure: input.toolExposure,
      planLimits: input.planLimits,
    });

    expect(first).toEqual(second);
    expect(new Set(first.bindings.map(({ callableName }) => callableName)).size)
      .toBe(first.bindings.length);
    expect(first.bindings.filter(({ kind }) => kind === "tool")).toHaveLength(FILE_TOOLS.length);
    expect(first.bindings.find((binding) =>
      binding.kind === "tool" && binding.toolName === "Read"
    )).toMatchObject({
      kind: "tool",
      callableName: expect.stringMatching(/^Read_[0-9a-f]{12}$/u),
      toolName: "Read",
      tool: { tool: { namespace: "helarc.code-agent", name: "read" }, revision: "2" },
    });
  });

  it("uses the same guidance-bound callable catalog for allocation and request construction", () => {
    const input = createControllerInput();
    const protocol = createTestControllerProtocol(input);
    const observedInteractions: unknown[] = [];
    const accounting = Object.freeze({
      ...TEST_INPUT_ACCOUNTING,
      estimateFraming(messages: Parameters<typeof TEST_INPUT_ACCOUNTING.estimateFraming>[0], interaction: Parameters<typeof TEST_INPUT_ACCOUNTING.estimateFraming>[1]) {
        observedInteractions.push(interaction);
        return TEST_INPUT_ACCOUNTING.estimateFraming(messages, interaction);
      },
    });
    const configuration = createHelarcContextProjectionConfiguration(accounting, protocol);
    const { context: _context, contextManifest: _manifest, ...preProjection } = input;

    configuration.allocate(preProjection);
    const request = buildProviderRequest(input, {
      ...requestBuildContext(),
      inputAccounting: accounting,
    }, protocol, createTestQualification(input, protocol));

    expect(observedInteractions[0]).toEqual(request.interaction);
    expect(request.metadata.modelCallableCatalogRevision).toBe(
      protocol.createCallableCatalog(input.toolExposure, input.planLimits).revision,
    );
  });

  it("fails missing guidance and changes catalog identity with model-visible definitions", () => {
    const input = createControllerInput();
    const guidance = createTestToolGuidance(input);
    const protocol = createHelarcControllerProtocolComposition({
      toolGuidance: guidance,
      controlGuidance: HELARC_CONTROLLER_CONTROL_GUIDANCE,
    });
    const original = protocol.createCallableCatalog(input.toolExposure, input.planLimits);
    const changedEntry = Object.freeze({
      ...guidance.entries[0]!,
      modelDescription: `${guidance.entries[0]!.modelDescription} Changed.`,
    });
    const changedGuidance = Object.freeze({
      ...guidance,
      id: createToolContractIdentity("agent-anything.helarc.test-guidance.changed.v1", changedEntry),
      entries: Object.freeze([changedEntry, ...guidance.entries.slice(1)]),
      contentDigest: createToolContractIdentity(
        "agent-anything.helarc.test-guidance-content.changed.v1",
        changedEntry,
      ),
    });
    const changed = createHelarcControllerProtocolComposition({
      toolGuidance: changedGuidance,
      controlGuidance: HELARC_CONTROLLER_CONTROL_GUIDANCE,
    }).createCallableCatalog(input.toolExposure, input.planLimits);
    const missingGuidance = Object.freeze({
      ...guidance,
      id: createToolContractIdentity("agent-anything.helarc.test-guidance.missing.v1", {}),
      entries: Object.freeze(guidance.entries.slice(1)),
      contentDigest: createToolContractIdentity(
        "agent-anything.helarc.test-guidance-content.missing.v1",
        {},
      ),
    });
    const missing = createHelarcControllerProtocolComposition({
      toolGuidance: missingGuidance,
      controlGuidance: HELARC_CONTROLLER_CONTROL_GUIDANCE,
    });

    expect(changed.revision).not.toBe(original.revision);
    expect(changed.definitionsDigest).not.toBe(original.definitionsDigest);
    expect(() => missing.createCallableCatalog(input.toolExposure, input.planLimits))
      .toThrow("Helarc Tool Guidance is missing");
  });

  it("keeps Product controls available when the Tool exposure is empty", () => {
    const input = createControllerInput();
    const request = buildHelarcProviderRequest({
      ...input,
      toolExposure: createToolExposure([]),
    }, requestBuildContext());

    expect(request.interaction).toMatchObject({ kind: "native_tool_turn" });
    if (request.interaction.kind !== "native_tool_turn") {
      throw new Error("Expected native Tool interaction.");
    }
    expect(request.interaction.callables.map(({ name }) => name)).toEqual([
      "stop",
      "update_plan",
    ]);
  });

  it("renders admitted Verification Context once through its current-turn section", () => {
    const controllerInput = createControllerInput();
    const verificationBlock = {
      id: "verification-block",
      item: { id: "verification-item" },
      contribution: { id: "verification-context-run-1", revision: "ledger-3" },
      instructionRole: "data" as const,
      payload: {
        kind: "structured" as const,
        value: {
          kind: "verification_feedback",
          snapshot: { runId: "run-1", revision: 3 },
          requirements: [],
          gate: null,
        },
      },
      accounting: { unit: "bytes" as const, amount: 1 },
      transformation: null,
    };
    const assembly = buildHelarcPromptAssembly({
      controllerInput: {
        ...controllerInput,
        context: {
          ...controllerInput.context,
          blocks: [verificationBlock],
          accounting: { unit: "bytes", amount: 1 },
        },
      },
    });
    const general = assembly.promptSections.find(({ id }) => id === "context_projection");
    const verification = assembly.promptSections.find(({ id }) => id === "current_verification");

    expect(general?.content).not.toContain("verification_feedback");
    expect(verification?.content).toContain("verification_feedback");
    expect(assembly.sections.find(({ id }) => id === "helarc:model-input:current_verification")?.source)
      .toMatchObject({ owner: "context", id: "projection-1", revision: "1" });
  });

  it("places Run-owned model interaction history before current state material", () => {
    const input = createControllerInput();
    const request = buildHelarcProviderRequest({
      ...input,
      interaction: {
        id: "run-1:model-interaction",
        revision: "7",
        messages: [{
          role: "assistant",
          content: [{ kind: "text", text: "I inspected the workspace." }],
        }],
        unsettledCalls: [],
        settledCallCount: 1,
      },
    }, requestBuildContext());
    const historyIndex = request.messages.findIndex((message) =>
      message.role === "assistant" && message.content.some((block) =>
        block.kind === "text" && block.text === "I inspected the workspace."
      )
    );
    const stateIndex = request.messages.findIndex((message) =>
      message.role === "user" && message.content.some((block) =>
        block.kind === "text" && block.text.startsWith("Context projection:")
      )
    );

    expect(historyIndex).toBeGreaterThan(-1);
    expect(stateIndex).toBeGreaterThan(historyIndex);
    expect(request.metadata).toMatchObject({
      interactionProjectionId: "run-1:model-interaction",
      interactionProjectionRevision: "7",
      interactionMessageCount: 1,
    });
  });

  it("rejects correction attempts and unsettled calls before transport", () => {
    expect(() => buildHelarcProviderRequest(createControllerInput(), {
      ...requestBuildContext(),
      attemptNumber: 2,
      correction: {
        previousAttemptNumber: 1,
        failure: {
          category: "structured_output_syntax",
          code: "legacy_json_failure",
          correctionFeedback: "Return JSON.",
        },
      },
    })).toThrow("do not accept structured-output correction");

    const input = createControllerInput();
    const response = nativeResponse(input, [{ kind: "call", name: "unknown", input: {} }]);
    if (response.kind !== "native_tool_turn") throw new Error("Expected native response.");
    const unsettled = response.turn.assistant.content.flatMap((block) =>
      block.kind === "model_tool_call" ? [block.call.modelCallRef] : []
    );
    expect(() => buildHelarcProviderRequest({
      ...input,
      interaction: { ...input.interaction, unsettledCalls: unsettled },
    }, requestBuildContext())).toThrow("while a model call is unsettled");
  });

  it("fails complete mandatory input instead of omitting callable definitions", () => {
    const accounting = createUtf8ModelInputAccounting({
      providerId: "tiny-provider",
      model: "tiny-model",
      maximumInputBytes: 1_024,
      limitSource: "host_configured",
      estimator: { id: "tiny-provider.utf8-content", revision: "1" },
      framing: { id: "tiny-provider.framing", revision: "1" },
      renderRequest: (messages, interaction) => JSON.stringify({ messages, interaction }),
    });

    expect(() => buildHelarcProviderRequest(createControllerInput("tiny-provider", "tiny-model"), {
      attemptNumber: 1,
      correction: null,
      inputAccounting: accounting,
    })).toThrow("Complete mandatory model input exceeds the effective input limit.");
  });

  it("rejects an instruction binding for a different Provider model", () => {
    expect(() => buildHelarcProviderRequest(createControllerInput(), {
      attemptNumber: 1,
      correction: null,
      inputAccounting: createUtf8ModelInputAccounting({
        providerId: "other-provider",
        model: "other-model",
        maximumInputBytes: 4 * 1_024 * 1_024,
        limitSource: "host_configured",
        estimator: { id: "other.utf8", revision: "1" },
        framing: { id: "other.framing", revision: "1" },
        renderRequest: (messages) => messageText(messages),
      }),
    })).toThrow("must match");
  });

  it("binds native Tool calls to exact domain Tool requests and preserves order", () => {
    const input = createControllerInput();
    const catalog = createHelarcModelCallableCatalog({
      toolExposure: input.toolExposure,
      planLimits: input.planLimits,
    });
    const read = toolCallable(catalog, "Read");
    const write = toolCallable(catalog, "Write");
    const decision = parseHelarcProviderResponse(nativeResponse(input, [
      { kind: "text", text: "I will inspect and then write." },
      { kind: "call", name: read, input: { file_path: "src/index.ts" } },
      { kind: "call", name: write, input: { file_path: "out.txt", content: "done" } },
    ]), input);

    expect(decision).toMatchObject({
      kind: "advance",
      candidates: [
        {
          kind: "tool_request",
          tool: {
            name: "Read",
            revision: "2",
            input: { file_path: "src/index.ts" },
            origin: "model",
            controllerRequestId: "controller-request-1",
          },
        },
        {
          kind: "tool_request",
          tool: {
            name: "Write",
            revision: "2",
            input: { file_path: "out.txt", content: "done" },
          },
        },
      ],
    });
    if (decision.kind !== "advance") throw new Error("Expected advance decision.");
    expect(decision.candidates.map(({ modelCallRef }) => modelCallRef.contentBlockOrdinal))
      .toEqual([1, 2]);
    expect(decision.modelItems.map(({ kind }) => kind)).toEqual([
      "assistant_text",
      "model_tool_call",
      "model_tool_call",
      "model_turn_finish",
      "model_response_correlation",
    ]);
  });

  it("maps update_plan to a Runner-owned state transition", () => {
    const input = createControllerInput();
    const decision = parseHelarcProviderResponse(nativeResponse(input, [{
      kind: "call",
      name: "update_plan",
      input: {
        explanation: "The task has multiple steps.",
        plan: [
          { step: "Inspect files", status: "in_progress" },
          { step: "Apply exact change", status: "pending" },
        ],
      },
    }]), input);

    expect(decision).toMatchObject({
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

  it("maps text completion, stop control, and refusal to terminal decisions", () => {
    const input = createControllerInput();

    expect(parseHelarcProviderResponse(nativeResponse(input, [
      { kind: "text", text: "The task is complete." },
    ]), input)).toMatchObject({
      kind: "propose_completion",
      output: { kind: "complete", summary: "The task is complete." },
    });
    expect(parseHelarcProviderResponse(nativeResponse(input, [{
      kind: "call",
      name: "stop",
      input: { reason: "Cannot continue safely." },
    }]), input)).toMatchObject({
      kind: "propose_stop",
      reason: "Cannot continue safely.",
    });
    expect(parseHelarcProviderResponse(nativeResponse(
      input,
      [{ kind: "text", text: "Policy refusal." }],
      { kind: "refusal", reason: null },
    ), input)).toMatchObject({
      kind: "propose_stop",
      reason: "Policy refusal.",
    });
  });

  it("turns unknown, malformed, and mixed stop calls into explicit rejection candidates", () => {
    const input = createControllerInput();
    const catalog = createHelarcModelCallableCatalog({
      toolExposure: input.toolExposure,
      planLimits: input.planLimits,
    });
    const read = toolCallable(catalog, "Read");

    expect(parseHelarcProviderResponse(nativeResponse(input, [{
      kind: "call",
      name: "not_in_catalog",
      input: {},
    }]), input)).toMatchObject({
      kind: "advance",
      candidates: [{ kind: "model_call_rejection", code: "model_callable_unknown" }],
    });
    expect(parseHelarcProviderResponse(nativeResponse(input, [{
      kind: "call",
      name: "stop",
      input: { reason: "" },
    }]), input)).toMatchObject({
      kind: "advance",
      candidates: [{ kind: "model_call_rejection", code: "stop_input_invalid" }],
    });
    expect(parseHelarcProviderResponse(nativeResponse(input, [
      { kind: "call", name: "stop", input: { reason: "Stop." } },
      { kind: "call", name: read, input: { file_path: "README.md" } },
    ]), input)).toMatchObject({
      kind: "advance",
      candidates: [
        { kind: "model_call_rejection", code: "stop_must_be_sole_call" },
        { kind: "tool_request", tool: { name: "Read" } },
      ],
    });
  });

  it("rejects abnormal finishes and mismatched call correlation", () => {
    const input = createControllerInput();
    expectControllerFailure(
      () => parseHelarcProviderResponse(
        nativeResponse(input, [], { kind: "output_limit" }),
        input,
      ),
      "helarc_model_finish_output_limit",
    );
    expectControllerFailure(
      () => parseHelarcProviderResponse(nativeResponse(input, [{
        kind: "call",
        name: "update_plan",
        input: { plan: [{ step: "Inspect", status: "in_progress" }] },
      }], { kind: "normal" }, "wrong-branch"), input),
      "helarc_model_call_correlation_mismatch",
    );
  });

  it("drives ProviderBackedController through native turns without structured correction", async () => {
    const provider = new FakeProvider((request) => nativeTextResponseFromRequest(request, "Done."));
    const controller = new ProviderBackedController<HelarcAgentOutput>({
      provider,
      buildRequest: buildHelarcProviderRequest,
      parseResponse: parseHelarcProviderResponse,
      responseProtocol: { kind: "native_tool_turn" },
      retryExecutor: createSystemRetryExecutor(),
      retryClock: systemRetryClock,
    });

    await expect(controller.next(createControllerInput(), controllerCallContext()))
      .resolves.toMatchObject({
        kind: "propose_completion",
        output: { kind: "complete", summary: "Done." },
      });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.interaction.kind).toBe("native_tool_turn");
  });
});

const FILE_TOOLS = [
  tool("Read", true),
  tool("Glob", true),
  tool("Grep", true),
  tool("Edit", false),
  tool("Write", false),
];

function createControllerInput(
  providerId = "fake-provider",
  modelId = "helarc-controller-test-model",
): ControllerInput<HelarcAgentOutput> {
  const agent = {
    id: "helarc",
    revision: "1",
    name: "Helarc",
    instructions: testAgentInstructions("helarc", providerId, modelId),
    output: {
      validate: (candidate: unknown) => ({
        valid: true as const,
        output: candidate as HelarcAgentOutput,
      }),
    },
    metadata: {},
  };
  return {
    runId: "run-1",
    iteration: 1,
    agent,
    instructionBinding: createAgentInstructionBinding({
      run: { id: "run-1" },
      agent,
      effectiveFromRunRevision: 0,
      supersedes: null,
    }),
    task: {
      id: "task-1",
      kind: "helarc.code-task",
      input: { prompt: "Update docs" },
      createdAt: "2026-07-08T00:00:00.000Z",
      metadata: {},
    },
    inputItems: [],
    toolExposure: createToolExposure(FILE_TOOLS),
    interaction: {
      id: "run-1:model-interaction",
      revision: "1",
      messages: [],
      unsettledCalls: [],
      settledCallCount: 0,
    },
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
    planLimits: {
      maxSteps: 8,
      maxStepLength: 500,
      maxExplanationLength: 2_000,
    },
    progress: {
      checkpointSequence: 0,
      consecutiveNonAdvancingCheckpoints: 0,
      correctionRounds: 0,
      activeCorrectionRound: null,
    },
    verification: { snapshot: { runId: "run-1", revision: 0 }, gate: null },
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
      approval: { canRequest: true, reviewer: "user", pendingCount: 0 },
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
    metadata: {},
  };
}

function testAgentInstructions(agentId: string, providerId: string, modelId: string) {
  return createAgentInstructions({
    id: `${agentId}.instructions`,
    release: { id: `${agentId}.release`, revision: "1" },
    model: { providerId, modelId },
    resolverRevision: "test-resolver.v1",
    blocks: [{
      id: "behavior",
      source: {
        owner: "test",
        kind: "instruction_source",
        id: `${agentId}.behavior`,
        revision: "1",
      },
      content: "Complete the code task.",
    }],
  });
}

function tool(name: string, readOnly: boolean): ToolDescriptorInput {
  const operationName = name.toLowerCase();
  return {
    ref: {
      tool: { namespace: "helarc.code-agent", name: operationName },
      revision: "2",
    },
    name,
    description: `${name} a Workspace file.`,
    inputSchema: name === "Read"
      ? {
          type: "object",
          additionalProperties: false,
          required: ["file_path"],
          properties: { file_path: { type: "string" } },
        }
      : name === "Write"
        ? {
            type: "object",
            additionalProperties: false,
            required: ["file_path", "content"],
            properties: {
              file_path: { type: "string" },
              content: { type: "string" },
            },
          }
        : {},
    schemaRevisions: {
      dialect: "json-schema-2020-12",
      input: "2",
      output: "2",
      translation: "native-2",
    },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly },
    source: {
      kind: "product",
      sourceId: "helarc.code-agent",
      sourceRevision: "2",
      activationEpoch: null,
    },
    binding: {
      kind: "operation",
      operation: {
        operation: { namespace: "helarc.code-agent.file", name: operationName },
        revision: "2",
      },
      revision: "2",
    },
    metadata: {},
  };
}

function createToolExposure(tools: readonly ToolDescriptorInput[]): ToolExposureProof {
  const catalog = createToolCatalogSnapshot(tools);
  return Object.freeze({
    schemaVersion: 1 as const,
    id: "tool-exposure-1",
    selectionRevision: "tool-selection-1",
    contentRevision: "tool-exposure-content-1",
    basisRevision: "tool-exposure-basis-1",
    consumer: "controller" as const,
    controllerRequestId: "controller-request-1",
    exposedTools: Object.freeze(catalog.tools.map(({ ref }) => ref)),
    omittedToolCount: 0,
    omissionReasons: Object.freeze([]),
    catalog,
  });
}

function createTestControllerProtocol(
  input: ControllerInput<HelarcAgentOutput>,
) {
  return createHelarcControllerProtocolComposition({
    toolGuidance: createTestToolGuidance(input),
    controlGuidance: HELARC_CONTROLLER_CONTROL_GUIDANCE,
  });
}

function createTestToolGuidance(
  input: ControllerInput<HelarcAgentOutput>,
): ResolvedHelarcToolGuidance {
  const entries = Object.freeze(input.toolExposure.catalog.tools.map((descriptor) => {
    const inputFieldDescriptions = Object.freeze(Object.fromEntries(
      Object.keys(
        descriptor.inputSchema.properties !== null &&
          typeof descriptor.inputSchema.properties === "object" &&
          !Array.isArray(descriptor.inputSchema.properties)
          ? descriptor.inputSchema.properties
          : {},
      ).map((name) => [
        `/properties/${name}`,
        `Complete test-only meaning for the ${descriptor.name}.${name} input field.`,
      ]),
    ));
    const inputSchema = annotateTestInputSchema(
      descriptor.inputSchema,
      inputFieldDescriptions,
    );
    const sourceRevision = createToolContractIdentity(
      "agent-anything.helarc.test-tool-guidance-source.v1",
      { tool: descriptor.ref, inputFieldDescriptions },
    );
    const fields = {
      tool: descriptor.ref,
      name: descriptor.name,
      source: Object.freeze({ id: `test-guidance.${descriptor.name}`, revision: sourceRevision }),
      modelDescription: `Use the complete test-only ${descriptor.name} Tool definition for its exact fixture Contract.`,
      inputFieldDescriptions,
      inputSchema,
      canonicalSchemaDigest: createToolContractIdentity(
        "agent-anything.helarc.test-canonical-schema.v1",
        descriptor.inputSchema,
      ),
      annotatedSchemaDigest: createToolContractIdentity(
        "agent-anything.helarc.test-annotated-schema.v1",
        inputSchema,
      ),
      descriptorFingerprint: descriptor.fingerprint,
      registrationFingerprint: createToolContractIdentity(
        "agent-anything.helarc.test-registration.v1",
        descriptor.ref,
      ),
      bindingDigest: createToolContractIdentity(
        "agent-anything.helarc.test-binding.v1",
        descriptor.binding,
      ),
    };
    return Object.freeze({
      ...fields,
      contentDigest: createToolContractIdentity(
        "agent-anything.helarc.test-resolved-guidance-entry.v1",
        fields,
      ),
    });
  }));
  const selectedTools = Object.freeze(entries.map((entry) => Object.freeze({
    tool: entry.tool,
    name: entry.name,
    descriptorFingerprint: entry.descriptorFingerprint,
    registrationFingerprint: entry.registrationFingerprint,
    bindingDigest: entry.bindingDigest,
  })));
  const toolSelectionId = createToolContractIdentity(
    "agent-anything.helarc.test-selected-tools.v1",
    { revision: input.toolExposure.selectionRevision, tools: selectedTools },
  );
  const contentDigest = createToolContractIdentity(
    "agent-anything.helarc.test-resolved-tool-guidance.v1",
    { toolSelectionId, entries },
  );
  const guidance: ResolvedHelarcToolGuidance = Object.freeze({
    id: contentDigest,
    release: Object.freeze({
      id: "helarc.test-tool-guidance",
      revision: createToolContractIdentity(
        "agent-anything.helarc.test-tool-guidance-release.v1",
        selectedTools,
      ),
    }),
    productId: "helarc",
    providerId: input.agent.instructions.model.providerId,
    modelId: input.agent.instructions.model.modelId,
    guidanceProfileRevision: "helarc.test-tool-guidance-profile.v1",
    toolSelection: Object.freeze({
      schemaVersion: 1,
      id: toolSelectionId,
      toolSelectionRevision: input.toolExposure.selectionRevision,
      tools: selectedTools,
    }),
    entries,
    resolverRevision: "helarc.test-tool-guidance-resolver.v1",
    contentDigest,
  });
  return guidance;
}

function annotateTestInputSchema(
  schema: ToolDescriptorInput["inputSchema"],
  descriptions: Readonly<Record<string, string>>,
) {
  if (
    schema.properties === null ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties)
  ) return Object.freeze({ ...schema });
  return Object.freeze({
    ...schema,
    properties: Object.freeze(Object.fromEntries(
      Object.entries(schema.properties).map(([name, value]) => [
        name,
        Object.freeze({
          ...(value as Readonly<Record<string, unknown>>),
          description: descriptions[`/properties/${name}`],
        }),
      ]),
    )),
  });
}

function requestBuildContext() {
  return {
    attemptNumber: 1,
    correction: null,
    inputAccounting: TEST_INPUT_ACCOUNTING,
  };
}

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

type NativeBlock =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "call";
      readonly name: string;
      readonly input: Readonly<Record<string, ModelJsonValue>>;
    };

function nativeResponse(
  input: ControllerInput<HelarcAgentOutput>,
  blocks: readonly NativeBlock[],
  finish: ModelTurnFinish = { kind: "normal" },
  branchId = `${input.runId}:main`,
): ProviderResponse {
  const requestId = `${input.runId}:model-input:${input.iteration}:1`;
  const turnId = `${requestId}:turn`;
  const content: ModelAssistantContentBlock[] = blocks.map((block, ordinal) => {
    if (block.kind === "text") return Object.freeze(block);
    const modelCallRef = createModelCallRef({
      providerRequestId: requestId,
      controllerRequestId: input.toolExposure.controllerRequestId,
      turnId,
      contentBlockOrdinal: ordinal,
      branchId,
    });
    return Object.freeze({
      kind: "model_tool_call" as const,
      call: Object.freeze({
        modelCallRef,
        providerCallRef: Object.freeze({
          providerId: "fake-provider",
          id: `provider-call-${ordinal}`,
        }),
        name: block.name,
        input: block.input,
        ordinal,
      }),
    });
  });
  return Object.freeze({
    kind: "native_tool_turn",
    turn: Object.freeze({
      turnId,
      assistant: Object.freeze({ role: "assistant", content: Object.freeze(content) }),
      finish,
      usage: null,
      responseRef: Object.freeze({
        providerId: "fake-provider",
        requestId,
        responseId: `${requestId}:response`,
      }),
    }),
    continuation: null,
    metadata: Object.freeze({}),
  });
}

function nativeTextResponseFromRequest(
  request: ProviderRequest,
  text: string,
): ProviderResponse {
  const turnId = `${request.requestId}:turn`;
  return Object.freeze({
    kind: "native_tool_turn",
    turn: Object.freeze({
      turnId,
      assistant: Object.freeze({
        role: "assistant",
        content: Object.freeze([{ kind: "text", text }]),
      }),
      finish: Object.freeze({ kind: "normal" }),
      usage: null,
      responseRef: Object.freeze({
        providerId: "fake-provider",
        requestId: request.requestId,
        responseId: `${request.requestId}:response`,
      }),
    }),
    continuation: null,
    metadata: Object.freeze({}),
  });
}

function toolCallable(
  catalog: ReturnType<typeof createHelarcModelCallableCatalog>,
  toolName: string,
): string {
  const binding = catalog.bindings.find((candidate) =>
    candidate.kind === "tool" && candidate.toolName === toolName
  );
  if (binding === undefined) throw new Error(`Missing Tool callable for ${toolName}.`);
  return binding.callableName;
}

function expectControllerFailure(action: () => unknown, helarcCode: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ControllerError);
    expect((error as ControllerError).failure.failure).toMatchObject({
      code: "model_output_invalid",
      metadata: { helarcCode },
    });
    return;
  }
  throw new Error(`Expected ControllerError '${helarcCode}'.`);
}

class FakeProvider implements Provider {
  readonly inputAccounting = TEST_INPUT_ACCOUNTING;
  readonly descriptor = {
    id: "fake-provider",
    name: "Fake provider",
    capabilities: {
      nativeToolInteraction: {
        supported: true as const,
        callableDefinitions: true as const,
        modelCalls: true as const,
        resultMessages: true as const,
        multipleCalls: true,
        callCorrelation: "provider_supplied" as const,
      },
      structuredGeneration: { supported: true as const },
      streaming: { supported: false as const },
      modelInput: this.inputAccounting.capability,
      continuation: { supported: false as const },
      compaction: { supported: false as const },
    },
    requestRetryScheduler: { kind: "harness" as const },
    metadata: {},
  };
  readonly requests: ProviderRequest[] = [];

  constructor(
    private readonly response: (request: ProviderRequest) => ProviderResponse,
  ) {}

  async send(
    request: ProviderRequest,
    _context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    this.requests.push(request);
    return { kind: "succeeded", response: this.response(request) };
  }
}

function messageText(messages: ProviderRequest["messages"]): string {
  return messages.flatMap((message) => message.content)
    .map((block) => block.kind === "text" ? block.text : JSON.stringify(block))
    .join("\n");
}
