import type {
  InvocationInterruptionContext,
  ProviderRequest,
} from "@agent-anything/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider, type FetchLike } from "./OpenAICompatibleProvider.js";

describe("OpenAICompatibleProvider", () => {
  afterEach(() => vi.useRealTimers());

  it("sends an OpenAI-compatible chat completions request", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const provider = new OpenAICompatibleProvider({
      providerKind: "openai-compatible",
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

    const result = await provider.send(request(), context());

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
      kind: "succeeded",
      response: {
        output: "{\"action\":\"complete\",\"summary\":\"done\"}",
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
    });
  });

  it("maps HTTP failure without leaking credentials", async () => {
    const provider = new OpenAICompatibleProvider({
      providerKind: "openai-compatible",
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

    const result = await provider.send(request(), context());

    expect(result).toMatchObject({
      kind: "failed",
      failure: {
        code: "provider_http_error",
        message: "Provider request failed with HTTP 401.",
        statusCode: 401,
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("projects trusted HTTP retry metadata into ProviderFailure", async () => {
    const provider = new OpenAICompatibleProvider(config(), async () => ({
      ok: false,
      status: 429,
      headers: {
        get(name) {
          if (name === "retry-after") return "2";
          if (name === "x-request-id") return "request_429";
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
        statusCode: 429,
        retryAfterMs: 2_000,
        requestId: "request_429",
        metadata: {},
      },
    });
  });

  it("maps malformed provider responses", async () => {
    const provider = new OpenAICompatibleProvider(config(), async () => okResponse({ choices: [] }));

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
    const provider = new OpenAICompatibleProvider(config(), abortingFetch);
    const result = provider.send(request(), context());

    await vi.advanceTimersByTimeAsync(1000);

    await expect(result).resolves.toMatchObject({
      kind: "failed",
      failure: { code: "provider_timeout" },
    });
  });

  it("does not classify an unrelated AbortError as timeout or Run cancellation", async () => {
    const provider = new OpenAICompatibleProvider(config(), async () => {
      throw Object.assign(new Error("unrelated abort"), { name: "AbortError" });
    });

    await expect(provider.send(request(), context())).resolves.toMatchObject({
      kind: "failed",
      failure: {
        category: "transport",
        code: "provider_request_failed",
        metadata: { causeName: "AbortError" },
      },
    });
  });

  it("returns exact Run cancellation when it aborts the active request", async () => {
    const interruption = cancellableContext();
    const provider = new OpenAICompatibleProvider(config(), async (_url, init) => {
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

  it("does not start transport work for an already-cancelled invocation", async () => {
    const interruption = cancellableContext();
    interruption.cancel();
    const fetchImpl = vi.fn(async () => okResponse({ choices: [] }));
    const provider = new OpenAICompatibleProvider(config(), fetchImpl);

    await expect(provider.send(request(), interruption.context)).resolves.toEqual({
      kind: "cancelled",
      cancellation: { runId: "run_001", requestId: "cancel_001" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function config() {
  return {
    providerKind: "openai-compatible" as const,
    baseUrl: "https://provider.local/v1",
    apiKey: "",
    model: "model-a",
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
