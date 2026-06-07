import { describe, expect, it } from "vitest";
import { FakeProvider } from "./FakeProvider.js";
import type { ProviderRequest } from "./ProviderRequest.js";
import type { ProviderResponse } from "./ProviderResponse.js";

describe("FakeProvider", () => {
  it("returns deterministic queued responses in order", async () => {
    const provider = new FakeProvider({
      responses: [
        createResponse("first"),
        createResponse("second"),
      ],
    });

    await expect(provider.send(createRequest("request_001"))).resolves.toMatchObject({
      status: "succeeded",
      output: "first",
    });
    await expect(provider.send(createRequest("request_002"))).resolves.toMatchObject({
      status: "succeeded",
      output: "second",
    });
  });

  it("records provider requests for assertions", async () => {
    const provider = new FakeProvider({
      responses: [createResponse("ok")],
    });

    await provider.send(createRequest("request_001"));

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
        metadata: {
          requestId: "request_001",
        },
      },
    ]);
  });

  it("returns structured failure when responses are exhausted", async () => {
    const provider = new FakeProvider();

    const response = await provider.send(createRequest("request_001"));

    expect(response).toEqual({
      status: "failed",
      output: null,
      usage: null,
      error: {
        code: "fake_provider_exhausted",
        message: "FakeProvider has no queued response.",
      },
      metadata: {
        providerId: "fake-provider",
      },
    });
  });

  it("exposes provider capabilities", () => {
    const provider = new FakeProvider({
      capabilities: {
        id: "fake-openai",
        name: "Fake OpenAI",
        supportsStreaming: true,
      },
    });

    expect(provider.capabilities).toMatchObject({
      id: "fake-openai",
      name: "Fake OpenAI",
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: true,
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
    metadata: {
      requestId,
    },
  };
}

function createResponse(output: string): ProviderResponse<string> {
  return {
    status: "succeeded",
    output,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      metadata: {},
    },
    error: null,
    metadata: {},
  };
}
