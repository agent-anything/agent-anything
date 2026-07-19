import type {
  ProviderRequest,
} from "@agent-anything/providers";
import type { InvocationInterruptionContext } from "@agent-anything/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaProvider } from "./OllamaProvider.js";
import type { FetchLike } from "./OpenAICompatibleProvider.js";

describe("OllamaProvider", () => {
  afterEach(() => vi.useRealTimers());

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

    const result = await provider.send(request(), context());

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
      kind: "succeeded",
      response: {
        output: "{\"action\":\"complete\",\"summary\":\"done\"}",
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
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

    const result = await provider.send(request(), context());

    expect(result).toMatchObject({
      kind: "failed",
      failure: {
        code: "provider_http_error",
        message: "Provider request failed with HTTP 500.",
        statusCode: 500,
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("projects trusted HTTP retry metadata into ProviderFailure", async () => {
    const provider = new OllamaProvider(config(), async () => ({
      ok: false,
      status: 503,
      headers: {
        get(name) {
          if (name === "retry-after") return "0";
          if (name === "request-id") return "ollama_503";
          return null;
        },
      },
      async json() {
        return {};
      },
    }));

    await expect(provider.send(request(), context())).resolves.toMatchObject({
      kind: "failed",
      failure: {
        statusCode: 503,
        retryAfterMs: 0,
        requestId: "ollama_503",
        metadata: {},
      },
    });
  });

  it("maps malformed provider responses", async () => {
    const provider = new OllamaProvider(config(), async () => okResponse({ done: true }));

    await expect(provider.send(request(), context())).resolves.toMatchObject({
      kind: "failed",
      failure: { code: "provider_response_malformed" },
    });
  });

  it("maps timeout failures", async () => {
    vi.useFakeTimers();
    const abortingFetch: FetchLike = async (_url, init) => {
      await rejectWhenAborted(init.signal);
      throw new Error("unreachable");
    };
    const provider = new OllamaProvider(config(), abortingFetch);
    const result = provider.send(request(), context());

    await vi.advanceTimersByTimeAsync(1000);

    await expect(result).resolves.toMatchObject({
      kind: "failed",
      failure: { code: "provider_timeout" },
    });
  });

  it("returns exact Run cancellation when it aborts the active request", async () => {
    const interruption = cancellableContext();
    const provider = new OllamaProvider(config(), async (_url, init) => {
      await rejectWhenAborted(init.signal);
      throw new Error("unreachable");
    });
    const result = provider.send(request(), interruption.context);

    interruption.cancel();

    await expect(result).resolves.toEqual({
      kind: "cancelled",
      cancellation: { runId: "run_001", requestId: "cancel_001" },
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

function context(): InvocationInterruptionContext {
  return {
    signal: new AbortController().signal,
    interruption: null,
  };
}

function cancellableContext() {
  const controller = new AbortController();
  let interruption: InvocationInterruptionContext["interruption"] = null;
  return {
    context: {
      signal: controller.signal,
      get interruption() {
        return interruption;
      },
    } satisfies InvocationInterruptionContext,
    cancel() {
      interruption = {
        kind: "run_cancellation",
        cancellation: { runId: "run_001", requestId: "cancel_001" },
      };
      controller.abort(interruption);
    },
  };
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  });
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
