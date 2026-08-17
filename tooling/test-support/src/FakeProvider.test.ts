import type {
  ProviderCallResult,
  ProviderRequest,
  ProviderResponse,
} from "@agent-anything/model-interaction";
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

    expect(provider.requests()).toEqual([
      {
        messages: [
          {
            role: "user",
            content: "Plan next diagnostic step.",
            metadata: {
              requestId: "request_001",
            },
          },
        ],
        capability: "tool-planning",
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
          supportsStreaming: true,
        },
      },
    });

    expect(provider.descriptor).toMatchObject({
      id: "fake-openai",
      name: "Fake OpenAI",
      capabilities: {
        supportsToolPlanning: true,
        supportsStructuredOutput: true,
        supportsStreaming: true,
        continuation: { supported: false },
      },
    });
  });
});

function createRequest(requestId: string): ProviderRequest {
  return {
    messages: [
      {
        role: "user",
        content: "Plan next diagnostic step.",
        metadata: {
          requestId,
        },
      },
    ],
    capability: "tool-planning",
    continuation: null,
    metadata: {
      requestId,
    },
  };
}

function succeeded(output: string): ProviderCallResult<string> {
  return {
    kind: "succeeded",
    response: createResponse(output),
  };
}

function createResponse(output: string): ProviderResponse<string> {
  return {
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

function context(): InvocationInterruptionContext {
  return {
    signal: new AbortController().signal,
    interruption: null,
  };
}
