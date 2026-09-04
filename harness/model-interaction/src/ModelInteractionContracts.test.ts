import { describe, expect, it } from "vitest";
import {
  accountProviderTransport,
  createProviderSemanticRequestDigest,
  createModelCallRef,
  createModelTurnId,
  createNativeToolTurnInteraction,
  snapshotModelCallableDefinition,
  snapshotModelMessage,
  snapshotModelMessages,
  snapshotModelToolResult,
  snapshotModelTurn,
  snapshotModelTurnFinish,
  snapshotProviderCapabilities,
  snapshotProviderRequest,
  verifyProviderTransportAccounting,
  type ModelCallRef,
  type ModelCallableDefinition,
  type ModelMessage,
  type ModelToolCall,
} from "./index.js";
import {
  composeModelInput,
  modelInputFromComposition,
} from "./input/index.js";

const CALLABLE: ModelCallableDefinition = {
  name: "Read",
  description: "Read one workspace file.",
  inputSchema: {
    type: "object",
    properties: { file_path: { type: "string" } },
    required: ["file_path"],
    additionalProperties: false,
  },
};

describe("provider-neutral Model Interaction contracts", () => {
  it("derives stable turn and call identities from complete request lineage", () => {
    const turnInput = {
      providerId: "provider-1",
      requestId: "request-1",
      responseId: "response-1",
    };
    const turnId = createModelTurnId(turnInput);
    expect(createModelTurnId(turnInput)).toBe(turnId);
    expect(createModelTurnId({ ...turnInput, responseId: "response-2" })).not.toBe(turnId);

    const callInput = {
      providerRequestId: "request-1",
      controllerRequestId: "controller-request-1",
      turnId,
      contentBlockOrdinal: 0,
      branchId: "branch-1",
    };
    const callRef = createModelCallRef(callInput);
    expect(createModelCallRef(callInput)).toEqual(callRef);
    expect(createModelCallRef({ ...callInput, contentBlockOrdinal: 1 }).id)
      .not.toBe(callRef.id);
    expect(callRef).toMatchObject(callInput);
  });

  it("enforces role-discriminated message content", () => {
    expect(snapshotModelMessage({
      role: "assistant",
      content: [{ kind: "text", text: "Inspecting." }, toolCallBlock(1)],
    })).toMatchObject({ role: "assistant" });

    expect(() => snapshotModelMessage({
      role: "user",
      content: [toolCallBlock(0)],
    } as unknown as ModelMessage)).toThrow("unsupported field 'call'");
    expect(() => snapshotModelMessage({ role: "tool", content: [] })).toThrow(
      "must contain correlated results",
    );
  });

  it("rejects duplicate, malformed, and out-of-order call references", () => {
    expect(() => snapshotModelMessage({
      role: "assistant",
      content: [toolCallBlock(0), toolCallBlock(0)],
    })).toThrow("ordinal must match");

    const duplicate = {
      ...toolCall(1, "model-call-1"),
      providerCallRef: { providerId: "provider-1", id: "provider-call-0" },
    };
    expect(() => snapshotModelMessage({
      role: "assistant",
      content: [toolCallBlock(0), { kind: "model_tool_call", call: duplicate }],
    })).toThrow("Provider Call refs must be unique");

    expect(() => snapshotModelMessage({
      role: "assistant",
      content: [{
        kind: "model_tool_call",
        call: { ...toolCall(0), modelCallRef: { ...callRef(0), id: "" } },
      }],
    })).toThrow("ModelCallRef.id");

    expect(() => snapshotModelMessage({
      role: "assistant",
      content: [{ kind: "model_tool_call", call: toolCall(1, "model-call-1") }],
    })).toThrow("ordinal must match");
  });

  it("classifies finish state and verifies complete turn correlation", () => {
    for (const finish of [
      { kind: "normal" as const },
      { kind: "output_limit" as const },
      { kind: "refusal" as const, reason: "policy" },
      { kind: "content_filter" as const },
      { kind: "protocol_pause" as const },
      { kind: "unknown" as const, safeCode: "provider_finish" },
    ]) {
      expect(snapshotModelTurnFinish(finish)).toEqual(finish);
    }

    expect(snapshotModelTurn({
      turnId: "turn-1",
      assistant: { role: "assistant", content: [toolCallBlock(0)] },
      finish: { kind: "normal" },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUnits: null,
        metadata: {},
      },
      responseRef: {
        providerId: "provider-1",
        requestId: "request-1",
        responseId: "response-1",
      },
    })).toMatchObject({ turnId: "turn-1", finish: { kind: "normal" } });

    expect(() => snapshotModelTurn({
      turnId: "different-turn",
      assistant: { role: "assistant", content: [toolCallBlock(0)] },
      finish: { kind: "normal" },
      usage: null,
      responseRef: {
        providerId: "provider-1",
        requestId: "request-1",
        responseId: null,
      },
    })).toThrow("correlation does not match");
  });

  it("requires exact result settlement shape", () => {
    expect(snapshotModelToolResult({
      modelCallRef: callRef(0),
      providerCallRef: { providerId: "provider-1", id: "provider-call-1" },
      name: "Read",
      settlement: "denied",
      content: { code: "permission_denied" },
      sourceRefs: [{
        owner: "permission",
        kind: "decision",
        id: "permission-1",
        revision: "1",
      }],
    })).toMatchObject({ settlement: "denied" });

    expect(() => snapshotModelToolResult({
      modelCallRef: callRef(0),
      providerCallRef: null,
      name: "Read",
      settlement: "succeeded",
      content: null,
      sourceRefs: [],
    })).toThrow("bounded non-empty array");
  });

  it("keeps native Tools, structured generation, and streaming independent", () => {
    expect(snapshotProviderCapabilities({
      nativeToolInteraction: {
        supported: true,
        callableDefinitions: true,
        modelCalls: true,
        resultMessages: true,
        multipleCalls: false,
        callCorrelation: "provider_supplied",
      },
      structuredGeneration: { supported: false },
      streaming: { supported: true },
      modelContext: {
        capacity: { supported: false },
        requestedOutput: requestedOutput(),
        inputPreservation: inputPreservation(),
      },
      continuation: { supported: false },
      compaction: { supported: false },
      usageMetering: {
        inputTokens: "measured",
        outputTokens: "measured",
        costUnits: "unavailable",
      },
    })).toMatchObject({
      nativeToolInteraction: { supported: true },
      structuredGeneration: { supported: false },
      streaming: { supported: true },
      usageMetering: { inputTokens: "measured", costUnits: "unavailable" },
    });
  });

  it("rejects impossible request interactions and protected extra fields", () => {
    expect(() => createNativeToolTurnInteraction([
      CALLABLE,
      { ...CALLABLE },
    ])).toThrow("must be unique");
    expect(() => snapshotModelCallableDefinition({
      ...CALLABLE,
      credential: "must-not-enter-the-contract",
    } as unknown as ModelCallableDefinition)).toThrow("unsupported field 'credential'");

    const { composition } = nativeComposition();
    expect(() => snapshotProviderRequest({
      requestId: composition.id,
      purpose: "test",
      correlation: {
        controllerRequestId: "controller-request-1",
        branchId: "branch-1",
      },
      instructions: { content: [{ kind: "text", text: "Changed instructions." }] },
      messages: composition.messages,
      interaction: composition.interaction,
      composition,
      modelContext: requestModelContext(),
      continuation: null,
      metadata: {},
    })).toThrow("does not match");

    expect(() => snapshotProviderRequest({
      requestId: composition.id,
      purpose: "test",
      correlation: {
        controllerRequestId: "controller-request-1",
        branchId: "branch-1",
      },
      instructions: composition.instructions,
      messages: composition.messages,
      interaction: { kind: "text_generation" },
      composition,
      modelContext: requestModelContext(),
      continuation: null,
      metadata: {},
    })).toThrow("does not match");

    expect(() => snapshotProviderRequest({
      requestId: composition.id,
      purpose: "test",
      correlation: {
        controllerRequestId: "controller-request-1",
      },
      instructions: composition.instructions,
      messages: composition.messages,
      interaction: composition.interaction,
      composition,
      modelContext: requestModelContext(),
      continuation: null,
      metadata: {},
    } as unknown as Parameters<typeof snapshotProviderRequest>[0])).toThrow(
      "ProviderRequest.correlation.branchId",
    );
  });

  it("keeps semantic input separate from exact Provider transport accounting", () => {
    const { composition, encodedRequest } = nativeComposition();
    const modelInput = modelInputFromComposition(composition);
    const request = snapshotProviderRequest({
      requestId: composition.id,
      purpose: "test",
      correlation: {
        controllerRequestId: "controller-request-1",
        branchId: "branch-1",
      },
      instructions: modelInput.instructions,
      messages: modelInput.messages,
      interaction: composition.interaction,
      composition,
      modelContext: requestModelContext(),
      continuation: null,
      metadata: {},
    });
    const binding = {
      method: "POST" as const,
      endpoint: "https://provider.example/v1/chat",
      contentType: "application/json",
      encoding: "utf-8" as const,
    };
    const accounting = accountProviderTransport({
      encodedBody: encodedRequest,
      binding,
      limit: { maximumBytes: 1_000_000, source: "host_configured", revision: "1" },
    });

    expect(accounting.encodedBytes).toBe(new TextEncoder().encode(encodedRequest).byteLength);
    expect(encodedRequest).toContain("Read one workspace file.");
    expect(encodedRequest).toContain("file_path");
    expect(createProviderSemanticRequestDigest(request)).toMatch(/^sha256:/);
    expect(() => verifyProviderTransportAccounting({
      accounting,
      encodedBody: encodedRequest,
      binding,
    })).not.toThrow();
    expect(() => verifyProviderTransportAccounting({
      accounting,
      encodedBody: `${encodedRequest} `,
      binding,
    })).toThrow("does not match");
  });
});

function nativeComposition() {
  const interaction = createNativeToolTurnInteraction([CALLABLE]);
  const composition = composeModelInput({
    id: "request-1",
    providerId: "provider-1",
    model: "model-1",
    interaction,
    sections: [{
      id: "instructions",
      source: { owner: "test", kind: "instructions", id: "instructions", revision: "1" },
      kind: "agent_instruction",
      role: "instruction",
      necessity: "mandatory",
      content: { kind: "text", text: "Use the available callable." },
    }, {
      id: "task",
      source: { owner: "test", kind: "task", id: "task", revision: "1" },
      kind: "task",
      role: "user",
      necessity: "mandatory",
      content: { kind: "text", text: "Read package.json." },
    }],
    lineage: {
      instructionBinding: source("agent-runtime", "instruction_binding", "binding"),
      agent: source("agent-core", "agent_revision", "agent"),
      instructions: source("agent-core", "agent_instructions", "instructions"),
      instructionRelease: source("test", "instruction_release", "release"),
      instructionResolver: source("test", "instruction_resolver", "resolver"),
      instructionContent: source("agent-core", "instruction_content", "instructions"),
      instructionModel: { providerId: "provider-1", model: "model-1" },
      instructionBlocks: [source("test", "instructions", "instructions")],
      activeContext: null,
      contextProjection: null,
      projectionManifest: null,
      toolSelection: source("tools", "selection", "selection"),
      toolExposureContent: source("tools", "exposure_content", "exposure"),
      toolExposureBasis: source("tools", "exposure_basis", "basis"),
      toolExposureProof: source("tools", "exposure_proof", "proof"),
      toolGuidance: source("product", "tool_guidance", "guidance"),
      controllerControlGuidance: source("product", "controller_control_guidance", "controls"),
      callableDefinitions: source("product", "callable_definitions", "callables"),
      modelQualification: source("product", "model_qualification", "qualification"),
      interactionHistory: null,
      protocol: source("test", "protocol", "native-tool-turn"),
      policy: source("test", "policy", "default"),
    },
    composedAt: "2026-08-27T00:00:00.000Z",
  });
  const modelInput = modelInputFromComposition(composition);
  return {
    composition,
    encodedRequest: JSON.stringify({
      instructions: modelInput.instructions,
      messages: modelInput.messages,
      interaction: composition.interaction,
    }),
  };
}

function requestedOutput() {
  return {
    unit: "tokens" as const,
    maximum: 1_024,
    source: "host_configured" as const,
    revision: "output-1",
  };
}

function inputPreservation() {
  return {
    providerId: "provider-1",
    model: "model-1",
    adapterRevision: "adapter-1",
    runtimeVersion: null,
    truncation: "unknown" as const,
    contextShift: "unknown" as const,
    evidence: [],
    revision: "preservation-1",
  };
}

function requestModelContext() {
  return {
    requestedOutput: requestedOutput(),
    headroom: {
      unit: "tokens" as const,
      amount: 128,
      policy: { id: "test-headroom", revision: "1" },
    },
    assessment: null,
  };
}

function toolCallBlock(ordinal: number) {
  return { kind: "model_tool_call" as const, call: toolCall(ordinal) };
}

function toolCall(ordinal: number, id = `model-call-${ordinal}`): ModelToolCall {
  return {
    modelCallRef: callRef(ordinal, id),
    providerCallRef: { providerId: "provider-1", id: `provider-call-${ordinal}` },
    name: "Read",
    input: { file_path: "package.json" },
    ordinal,
  };
}

function callRef(ordinal: number, id = `model-call-${ordinal}`): ModelCallRef {
  return {
    id,
    providerRequestId: "request-1",
    controllerRequestId: "controller-request-1",
    turnId: "turn-1",
    contentBlockOrdinal: ordinal,
    branchId: "branch-1",
  };
}

function source(owner: string, kind: string, id: string) {
  return { owner, kind, id, revision: "1" };
}
