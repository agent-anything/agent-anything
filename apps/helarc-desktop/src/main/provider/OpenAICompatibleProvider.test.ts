import type { ProviderRequest } from "@agent-anything/providers";
import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider, type FetchLike } from "./OpenAICompatibleProvider.js";

describe("OpenAICompatibleProvider", () => {
  it("sends an OpenAI-compatible chat completions request", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://provider.local/v1/",
      apiKey: "secret-key",
      model: "model-a",
      timeoutMs: 1000,
    }, async (url, init) => {
      calls.push({
        url,
        headers: init.headers,
        body: JSON.parse(init.body) as unknown,
      });
      return okResponse({
        choices: [{ message: { content: "{\"action\":\"complete\",\"summary\":\"done\"}" } }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      });
    });

    const result = await provider.send(request());

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://provider.local/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-key",
      },
      body: {
        model: "model-a",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
    });
    expect(result).toMatchObject({
      status: "succeeded",
      output: "{\"action\":\"complete\",\"summary\":\"done\"}",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });
  });

  it("maps HTTP failure without leaking credentials", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://provider.local/v1",
      apiKey: "secret-key",
      model: "model-a",
      timeoutMs: 1000,
    }, async () => ({
      ok: false,
      status: 401,
      async json() {
        return { error: "secret-key" };
      },
    }));

    debugger;
    const result = await provider.send(request());

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "provider_http_error",
        message: "Provider request failed with HTTP 401.",
        metadata: { status: 401 },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("maps malformed provider responses", async () => {
    const provider = new OpenAICompatibleProvider(config(), async () => okResponse({ choices: [] }));

    await expect(provider.send(request())).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_response_malformed" },
    });
  });

  it("maps timeout failures", async () => {
    const abortingFetch: FetchLike = async (_url, init) => {
      init.signal.dispatchEvent(new Event("abort"));
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    const provider = new OpenAICompatibleProvider(config(), abortingFetch);

    await expect(provider.send(request())).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_timeout" },
    });
  });
});

function config() {
  return {
    baseUrl: "https://provider.local/v1",
    apiKey: "",
    model: "model-a",
    timeoutMs: 1000,
  };
}

function request(): ProviderRequest {
  return {
    capability: "helarc.code-agent.plan",
    messages: [{ role: "user", content: "hello", metadata: {} }],
    metadata: {},
  };
}

function okResponse(value: unknown) {
  return {
    ok: true,
    status: 200,
    async json() {
      return value;
    },
  };
}
