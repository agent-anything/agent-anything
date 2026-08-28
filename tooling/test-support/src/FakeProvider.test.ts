import type {
  ProviderCallResult,
  ProviderRequest,
  ProviderResponse,
} from "@agent-anything/model-interaction";
import {
  composeModelInput,
  createUtf8ModelInputAccounting,
  modelMessagesFromComposition,
} from "@agent-anything/model-interaction/input";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { describe, expect, it } from "vitest";
import { FakeProvider } from "./FakeProvider.js";

describe("FakeProvider", () => {
  it("returns deterministic queued responses in order", async () => {
    const provider = new FakeProvider({
      results: [
        succeeded("first"),
        succeeded("second"),
      ],
    });

    await expect(provider.send(createRequest("request_001"), context())).resolves.toMatchObject({
      kind: "succeeded",
      response: { output: "first" },
    });
    await expect(provider.send(createRequest("request_002"), context())).resolves.toMatchObject({
      kind: "succeeded",
      response: { output: "second" },
    });
  });

  it("records provider requests for assertions", async () => {
    const provider = new FakeProvider({
      results: [succeeded("ok")],
    });

    await provider.send(createRequest("request_001"), context());

    expect(provider.requests()).toMatchObject([
      {
        requestId: "request_001",
        purpose: "tool-planning",
        interaction: { kind: "text_generation" },
        messages: [
          { role: "system", content: [{ kind: "text", text: "Follow test instructions." }] },
          { role: "user", content: [{ kind: "text", text: "Plan next diagnostic step." }] },
        ],
        continuation: null,
        metadata: {
          requestId: "request_001",
        },
      },
    ]);
  });

  it("returns structured failure when responses are exhausted", async () => {
    const provider = new FakeProvider();

    const response = await provider.send(createRequest("request_001"), context());

    expect(response).toEqual({
      kind: "failed",
      failure: {
        category: "fake",
        code: "fake_provider_exhausted",
        message: "FakeProvider has no queued response.",
        metadata: {
          providerId: "fake-provider",
        },
      },
    });
  });

  it("exposes provider descriptor and capabilities separately", () => {
    const provider = new FakeProvider({
      descriptor: {
        id: "fake-openai",
        name: "Fake OpenAI",
        capabilities: {
          streaming: { supported: true },
        },
      },
    });

    expect(provider.descriptor).toMatchObject({
      id: "fake-openai",
      name: "Fake OpenAI",
      capabilities: {
        nativeToolInteraction: { supported: false },
        structuredGeneration: { supported: true },
        streaming: { supported: true },
        continuation: { supported: false },
        compaction: { supported: false },
      },
    });
  });
});

function createRequest(requestId: string): ProviderRequest {
  const accounting = createUtf8ModelInputAccounting({
    providerId: "fake-provider",
    model: "fake-model",
    maximumInputBytes: 1_000_000,
    limitSource: "host_configured",
    estimator: { id: "fake-provider.utf8-content", revision: "1" },
    framing: { id: "fake-provider.framing", revision: "1" },
    renderRequest: (messages, interaction) => JSON.stringify({ messages, interaction }),
  });
  const interaction = { kind: "text_generation" as const };
  const composition = composeModelInput({
    id: requestId,
    providerId: "fake-provider",
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
      role: "system",
      necessity: "mandatory",
      content: { kind: "text", text: "Follow test instructions." },
    }, {
      id: "request",
      source: source("request"),
      kind: "task",
      role: "user",
      necessity: "mandatory",
      content: { kind: "text", text: "Plan next diagnostic step." },
    }],
    lineage: {
      instructionBinding: source("binding"),
      agent: source("agent"),
      instructions: source("agent-instructions"),
      instructionRelease: source("release"),
      instructionResolver: source("resolver"),
      instructionContent: source("instruction-content"),
      instructionModel: { providerId: "fake-provider", model: "fake-model" },
      instructionBlocks: [source("instructions")],
      activeContext: null,
      contextProjection: null,
      projectionManifest: null,
      toolSelection: null,
      toolExposureContent: null,
      toolExposureBasis: null,
      toolExposureProof: null,
      toolGuidance: null,
      controllerControlGuidance: null,
      callableDefinitions: null,
      interactionHistory: null,
      protocol: source("protocol"),
      policy: source("policy"),
    },
    composedAt: "2026-08-27T00:00:00.000Z",
  });
  return {
    requestId,
    purpose: "tool-planning",
    correlation: {
      controllerRequestId: `${requestId}:controller`,
      branchId: `${requestId}:branch`,
    },
    messages: modelMessagesFromComposition(composition),
    interaction,
    composition,
    continuation: null,
    metadata: {
      requestId,
    },
  };
}

function succeeded(output: string): ProviderCallResult {
  return {
    kind: "succeeded",
    response: createResponse(output),
  };
}

function createResponse(output: string): ProviderResponse {
  return {
    kind: "text_generation",
    output,
    responseId: null,
    continuation: null,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      metadata: {},
    },
    metadata: {},
  };
}

function source(id: string) {
  return { owner: "test", kind: "fixture", id, revision: "1" };
}

function context(): InvocationInterruptionContext {
  return {
    signal: new AbortController().signal,
    interruption: null,
  };
}
