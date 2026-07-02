import type { ProviderRequest } from "@agent-anything/providers";
import { describe, expect, it } from "vitest";
import { OllamaProvider } from "./OllamaProvider.js";
import type { FetchLike } from "./OpenAICompatibleProvider.js";

describe("OllamaProvider", () => {
  it("sends an Ollama native generate request", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const provider = new OllamaProvider(config(), async (url, init) => {
      calls.push({
        url,
        headers: init.headers,
        body: JSON.parse(init.body) as unknown,
      });
      return okResponse({
        response: "{\"action\":\"complete\",\"summary\":\"done\"}",
        prompt_eval_count: 3,
        eval_count: 4,
      });
    });

    const result = await provider.send(request());

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://localhost:11434/api/generate",
      headers: {
        "content-type": "application/json",
      },
      body: {
        model: "gemma3:4b",
        prompt: "system: You are concise.\n\nuser: hello",
        stream: false,
      },
    });
    expect(result).toMatchObject({
      status: "succeeded",
      output: "{\"action\":\"complete\",\"summary\":\"done\"}",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });
  });

  it("maps HTTP failure without reading response body", async () => {
    const provider = new OllamaProvider(config(), async () => ({
      ok: false,
      status: 500,
      async json() {
        return { response: "secret" };
      },
    }));

    const result = await provider.send(request());

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "provider_http_error",
        message: "Provider request failed with HTTP 500.",
        metadata: { status: 500 },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("maps malformed provider responses", async () => {
    const provider = new OllamaProvider(config(), async () => okResponse({ done: true }));

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
    const provider = new OllamaProvider(config(), abortingFetch);

    await expect(provider.send(request())).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_timeout" },
    });
  });
});

function config() {
  return {
    providerKind: "ollama" as const,
    baseUrl: "http://localhost:11434/",
    apiKey: "",
    model: "gemma3:4b",
    timeoutMs: 1000,
  };
}

function request(): ProviderRequest {
  return {
    capability: "helarc.code-agent.plan",
    messages: [
      { role: "system", content: "You are concise.", metadata: {} },
      { role: "user", content: "hello", metadata: {} },
    ],
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
