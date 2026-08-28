import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import {
  createNativeToolTurnInteraction,
  type ProviderCallResult,
  type ProviderRequest,
} from "@agent-anything/model-interaction";
import {
  composeModelInput,
  createUtf8ModelInputAccounting,
  modelInputFromComposition,
} from "@agent-anything/model-interaction/input";
import { describe, expect, it } from "vitest";
import {
  FakeNativeToolProvider,
  fakeNativeModelOutput,
  fakeNativeProviderResult,
} from "./FakeNativeToolProvider.js";

describe("FakeNativeToolProvider", () => {
  it("creates one request-correlated native Tool call", async () => {
    const provider = new FakeNativeToolProvider({
      steps: [fakeNativeModelOutput({
        kind: "tool_call",
        toolName: "Read",
        input: { file_path: "package.json" },
      })],
    });
    const request = createRequest("request-1");

    const result = await provider.send(request, context());

    expect(result).toMatchObject({
      kind: "succeeded",
      response: {
        kind: "native_tool_turn",
        turn: {
          assistant: {
            content: [{
              kind: "model_tool_call",
              call: {
                modelCallRef: {
                  providerRequestId: "request-1",
                  controllerRequestId: "controller-request-1",
                  contentBlockOrdinal: 0,
                  branchId: "branch-1",
                },
                providerCallRef: {
                  providerId: "fake-native-tool-provider",
                  id: "fake-native-tool-provider:response:1:call:0",
                },
                name: "Read_1234",
                input: { file_path: "package.json" },
                ordinal: 0,
              },
            }],
          },
        },
      },
    });
    expect(provider.requests()).toEqual([request]);
  });

  it("creates a normal text-only completion turn", async () => {
    const provider = new FakeNativeToolProvider({
      steps: [fakeNativeModelOutput({ kind: "completion", summary: "Done." })],
    });

    await expect(provider.send(createRequest("request-2"), context())).resolves.toMatchObject({
      kind: "succeeded",
      response: {
        kind: "native_tool_turn",
        turn: {
          assistant: { content: [{ kind: "text", text: "Done." }] },
          finish: { kind: "normal" },
        },
      },
    });
  });

  it("passes through an explicit Provider result", async () => {
    const failure: ProviderCallResult = Object.freeze({
      kind: "failed",
      failure: Object.freeze({
        category: "transport",
        code: "provider_connection_failed",
        message: "The scripted transport failed.",
        metadata: Object.freeze({}),
      }),
    });
    const provider = new FakeNativeToolProvider({
      steps: [fakeNativeProviderResult(failure)],
    });

    await expect(provider.send(createRequest("request-3"), context())).resolves.toBe(failure);
  });

  it("provides a product-fulfillment result without consuming Controller steps", async () => {
    const provider = new FakeNativeToolProvider({
      steps: [fakeNativeModelOutput({ kind: "completion", summary: "Done." })],
    });
    const fulfillmentRequest = Object.freeze({
      ...createRequest("fulfillment-request"),
      purpose: "helarc.task-fulfillment",
      interaction: Object.freeze({
        kind: "structured_generation" as const,
        outputFormat: Object.freeze({
          kind: "json_schema" as const,
          name: "task_fulfillment",
          schemaId: "task-fulfillment",
          schemaRevision: "1",
          schema: Object.freeze({ type: "object" }),
        }),
      }),
    });

    await expect(provider.send(fulfillmentRequest, context())).resolves.toMatchObject({
      kind: "succeeded",
      response: {
        kind: "structured_generation",
        output: { status: "fulfilled", missingOutcomes: [], unsupportedClaims: [] },
      },
    });
    await expect(provider.send(createRequest("controller-request"), context())).resolves.toMatchObject({
      kind: "succeeded",
      response: { kind: "native_tool_turn" },
    });
  });

  it("fails malformed scripted output without inventing a native turn", async () => {
    const provider = new FakeNativeToolProvider({
      steps: [fakeNativeModelOutput("not-a-model-output")],
    });

    await expect(provider.send(createRequest("request-4"), context())).resolves.toMatchObject({
      kind: "failed",
      failure: { code: "provider_response_malformed" },
    });
  });
});

function createRequest(requestId: string): ProviderRequest {
  const interaction = createNativeToolTurnInteraction([{
    name: "Read_1234",
    description: "Read one workspace file.",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
      additionalProperties: false,
    },
  }]);
  const accounting = createUtf8ModelInputAccounting({
    providerId: "fake-native-tool-provider",
    model: "fake-model",
    maximumInputBytes: 1_000_000,
    limitSource: "host_configured",
    estimator: { id: "fake-native.utf8", revision: "1" },
    framing: { id: "fake-native.framing", revision: "1" },
    renderRequest: (instructions, messages, requestInteraction) =>
      JSON.stringify({ instructions, messages, interaction: requestInteraction }),
  });
  const composition = composeModelInput({
    id: requestId,
    providerId: "fake-native-tool-provider",
    model: "fake-model",
    accounting,
    interaction,
    outputReserve: { unit: "bytes", amount: 0 },
    contextBudget: { unit: "bytes", amount: 0 },
    contextProjectedAmount: 0,
    sections: [{
      id: "instructions",
      source: source("instructions"),
      kind: "agent_instruction",
      role: "instruction",
      necessity: "mandatory",
      content: { kind: "text", text: "Use the available callable." },
    }, {
      id: "request",
      source: source("request"),
      kind: "task",
      role: "user",
      necessity: "mandatory",
      content: { kind: "text", text: "Inspect package.json." },
    }],
    lineage: {
      instructionBinding: source("instruction-binding"),
      agent: source("agent"),
      instructions: source("agent-instructions"),
      instructionRelease: source("instruction-release"),
      instructionResolver: source("instruction-resolver"),
      instructionContent: source("instruction-content"),
      instructionModel: { providerId: "fake-native-tool-provider", model: "fake-model" },
      instructionBlocks: [source("instructions")],
      activeContext: null,
      contextProjection: null,
      projectionManifest: null,
      toolSelection: source("tool-selection"),
      toolExposureContent: source("tool-exposure-content"),
      toolExposureBasis: source("tool-exposure-basis"),
      toolExposureProof: source("tool-exposure-proof"),
      toolGuidance: source("tool-guidance"),
      controllerControlGuidance: source("controller-control-guidance"),
      callableDefinitions: source("callable-definitions"),
      modelQualification: null,
      interactionHistory: null,
      protocol: source("protocol"),
      policy: source("policy"),
    },
    composedAt: "2026-08-27T00:00:00.000Z",
  });
  const modelInput = modelInputFromComposition(composition);
  return Object.freeze({
    requestId,
    purpose: "test-native-tool-turn",
    correlation: {
      controllerRequestId: "controller-request-1",
      branchId: "branch-1",
    },
    instructions: modelInput.instructions,
    messages: modelInput.messages,
    interaction,
    composition,
    continuation: null,
    metadata: Object.freeze({}),
  });
}

function source(id: string) {
  return Object.freeze({ owner: "test-support", kind: "fixture", id, revision: "1" });
}

function context(): InvocationInterruptionContext {
  return Object.freeze({ signal: new AbortController().signal, interruption: null });
}
