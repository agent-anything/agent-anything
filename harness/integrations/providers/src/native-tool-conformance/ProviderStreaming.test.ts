import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { Provider, ProviderDeliveryProgress } from "@agent-anything/model-interaction";
import type { ProviderObservation, ProviderObserver } from "@agent-anything/model-interaction/transport";
import type { FetchLike } from "../http/ProviderHttpTransport.js";
import { OllamaProvider } from "../ollama/OllamaProvider.js";
import { OpenAICompatibleProvider } from "../openai-compatible/OpenAICompatibleProvider.js";
import { createNativeProviderRequest } from "./NativeToolInteractionTestSupport.js";

const text = "Inspect \u4f60\u597d.";
const limit = { maximumBytes: 1024 * 1024, source: "host_configured" as const, revision: "1" };
const factories = {
  ollama: (fetch: FetchLike, observer?: ProviderObserver): Provider => new OllamaProvider({
    baseUrl: "http://localhost:11434", model: "test-model", timeoutMs: 1000,
    runtime: { contextWindowTokens: 16384, maximumOutputTokens: 2048 },
    nativeToolInteraction: { supported: true }, requestBodyTransportLimit: limit,
  }, fetch, observer),
  openai: (fetch: FetchLike, observer?: ProviderObserver): Provider => new OpenAICompatibleProvider({
    baseUrl: "https://provider.local/v1", apiKey: "", model: "test-model", timeoutMs: 1000,
    maximumOutputTokens: 2048, nativeToolInteraction: { supported: true }, requestBodyTransportLimit: limit,
  }, fetch, observer),
};
type Format = keyof typeof factories;
const call = { name: "Read", arguments: { file_path: "package.json" } };
const ndjson = (value: unknown) => `${JSON.stringify(value)}\n`;
const sse = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({
  id: "response-1", choices: [{ index: 0, delta, finish_reason: finish }],
})}\n\n`;
function frames(format: Format): string[] {
  return format === "ollama" ? [
    ndjson({ message: { role: "assistant", content: text, thinking: "private analysis" }, done: false }),
    ndjson({ message: { role: "assistant", tool_calls: [{ function: call }] }, done: false }),
    ndjson({ done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 5 }),
  ] : [
    sse({ role: "assistant", content: text }),
    sse({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "Read", arguments: "{\"file_" } }] }),
    sse({ tool_calls: [{ index: 0, function: { arguments: "path\":\"package.json\"}" } }] }),
    sse({}, "tool_calls"),
    `data: ${JSON.stringify({ id: "response-1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
}
function buffered(format: Format): unknown {
  return format === "ollama" ? {
    message: { role: "assistant", content: text, thinking: "private analysis", tool_calls: [{ function: call }] },
    done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 5,
  } : {
    id: "response-1", choices: [{ index: 0, finish_reason: "tool_calls", message: {
      role: "assistant", content: text, tool_calls: [{ id: "call-1", type: "function", function: {
        name: call.name, arguments: JSON.stringify(call.arguments),
      } }],
    } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}
function response(body: ReadableStream<Uint8Array>) {
  return { ok: true, status: 200, body, json: vi.fn(async () => { throw new Error("Streaming must not use json()"); }) };
}
function body(value: string | Uint8Array, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
    controller.close();
  } });
}
function context(): InvocationInterruptionContext {
  return { signal: new AbortController().signal, interruption: null };
}
afterEach(() => vi.useRealTimers());

describe.each(["ollama", "openai"] as const)("%s streaming", (format) => {
  const create = factories[format];
  it("normalizes split UTF-8 and protocol frames identically to buffered native Tools", async () => {
    const observations: ProviderObservation[] = [];
    const progress: ProviderDeliveryProgress[] = [];
    const fetch = vi.fn(async () => response(body(frames(format).join(""), 1)));
    const provider = create(fetch, { observe: (event) => { observations.push(event); } });
    const request = createNativeProviderRequest(provider, { instructions: { content: [] } });
    const result = await provider.send(request, context(), { mode: "streaming", invocationId: "attempt-1",
      observer: { observe: (event) => { progress.push(event); } },
    });
    const reference = create(async () => ({ ok: true, status: 200, json: async () => buffered(format) }));
    expect(result.kind).toBe("succeeded");
    expect(result).toEqual(await reference.send(createNativeProviderRequest(reference, { instructions: { content: [] } }), context()));
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({ stream: true });
    expect(JSON.parse(fetch.mock.calls[0]![1].body).messages.some((entry: { role: string }) => entry.role === "system")).toBe(false);
    expect(progress.filter((entry) => entry.kind === "text_delta").map((entry) => entry.text).join("")).toBe(text);
    expect(JSON.stringify(progress)).not.toContain("private analysis");
    expect(progress.map((entry) => entry.sequence)).toEqual(progress.map((_, index) => index + 1));
    expect(progress.every((entry) => entry.invocationId === "attempt-1" && Object.isFrozen(entry))).toBe(true);
    expect(progress.at(-1)).toMatchObject({ kind: "settled", disposition: "completed", parts: [
      { partId: "text:0", contentBlockOrdinal: 0 }, { partId: "call:0", contentBlockOrdinal: 1 },
    ] });
    expect(observations.every((entry) => entry.attemptId === "attempt-1")).toBe(true);
    expect(observations.find((entry) => entry.stage === "response_body")?.representation).toBe("assembled_stream");
  });

  it("publishes progress before completion but returns no partial normalized response", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const provider = create(async () => response(stream));
    const progress: ProviderDeliveryProgress[] = [];
    let completed = false;
    const result = provider.send(createNativeProviderRequest(provider), context(), { mode: "streaming", invocationId: "early",
      observer: { observe: (event) => { progress.push(event); } },
    }).then((value) => { completed = true; return value; });
    source.enqueue(new TextEncoder().encode(frames(format)[0]));
    await vi.waitFor(() => expect(progress.some((entry) => entry.kind === "text_delta")).toBe(true));
    expect(completed).toBe(false);
    source.enqueue(new TextEncoder().encode(frames(format).slice(1).join("")));
    source.close();
    expect((await result).kind).toBe("succeeded");
    expect(progress.filter((entry) => entry.kind === "settled")).toHaveLength(1);
  });

  it.each(["throw", "reject", "pending"])("isolates a %s observer without delaying the response", async (behavior) => {
    const provider = create(async () => response(body(frames(format).join(""))));
    const result = await provider.send(createNativeProviderRequest(provider), context(), {
      mode: "streaming", invocationId: "isolated", observer: { observe() {
        if (behavior === "throw") throw new Error("observer failed");
        if (behavior === "reject") return Promise.reject(new Error("observer failed"));
        return new Promise<void>(() => {});
      } },
    });
    expect(result.kind).toBe("succeeded");
  });

  it("does not accept EOF without protocol completion", async () => {
    const progress: ProviderDeliveryProgress[] = [];
    const provider = create(async () => response(body(frames(format)[0]!)));
    expect(await provider.send(createNativeProviderRequest(provider), context(), { mode: "streaming", invocationId: "short",
      observer: { observe: (event) => { progress.push(event); } },
    })).toMatchObject({ kind: "failed", failure: { category: "transport", code: "provider_response_incomplete" } });
    expect(progress.at(-1)).toMatchObject({ kind: "settled", disposition: "interrupted", parts: [] });
  });

  it.each(["invalid_utf8", "bad_json", "missing_body", "oversized_frame", "oversized_text"])("rejects %s without fallback", async (kind) => {
    const payload = kind === "invalid_utf8" ? new Uint8Array([0xc3, 0x28])
      : kind === "bad_json" ? format === "ollama" ? "{bad}\n" : "data: {bad}\n\n"
      : kind === "oversized_text" ? format === "ollama"
        ? ndjson({ message: { content: "x".repeat(64001) }, done: true })
        : sse({ content: "x".repeat(64001) }, "stop")
      : `${format === "openai" ? "data: " : ""}${"x".repeat(1024 * 1024 + 1)}`;
    const fetch = vi.fn(async () => kind === "missing_body"
      ? { ok: true, status: 200, json: async () => buffered(format) }
      : response(body(payload, 65536)));
    const provider = create(fetch);
    expect(await provider.send(createNativeProviderRequest(provider), context(), { mode: "streaming", invocationId: kind }))
      .toMatchObject({ kind: "failed", failure: { category: "response", code: kind.startsWith("oversized")
        ? "provider_response_too_large" : "provider_response_malformed" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels an idle response body and discards its unfinished preview", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel: cancelled });
    const abort = new AbortController();
    let interruption: InvocationInterruptionContext["interruption"] = null;
    const progress: ProviderDeliveryProgress[] = [];
    const provider = create(async () => response(stream));
    const pending = provider.send(createNativeProviderRequest(provider), {
      signal: abort.signal, get interruption() { return interruption; },
    }, { mode: "streaming", invocationId: "cancelled", observer: { observe: (event) => { progress.push(event); } } });
    source.enqueue(new TextEncoder().encode(frames(format)[0]));
    await vi.waitFor(() => expect(progress.some((entry) => entry.kind === "text_delta")).toBe(true));
    interruption = { kind: "run_cancellation", cancellation: { runId: "run-1", requestId: "cancel-1" } };
    abort.abort(interruption);
    expect(await pending).toEqual({ kind: "cancelled", cancellation: interruption.cancellation });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(progress.at(-1)).toMatchObject({ kind: "settled", disposition: "cancelled", parts: [] });
  });

  it("times out after headers when the body stalls", async () => {
    vi.useFakeTimers();
    const provider = create(async () => response(new ReadableStream<Uint8Array>()));
    const pending = provider.send(createNativeProviderRequest(provider), context(), { mode: "streaming", invocationId: "timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ kind: "failed", failure: { code: "provider_timeout" } });
  });

  it("rejects in-band errors without exposing arbitrary upstream content", async () => {
    const payload = format === "ollama" ? ndjson({ error: "private upstream diagnostic" })
      : `data: ${JSON.stringify({ error: { message: "private upstream diagnostic" } })}\n\n`;
    const provider = create(async () => response(body(payload)));
    const result = await provider.send(createNativeProviderRequest(provider), context(), { mode: "streaming", invocationId: "in-band" });
    expect(result).toMatchObject({ kind: "failed", failure: { category: "response", code: "provider_response_malformed" } });
    expect(JSON.stringify(result)).not.toContain("private upstream diagnostic");
  });

  it("bounds total response bytes even when individual frames are small", async () => {
    const keepalive = format === "ollama" ? "\n" : ": keepalive\n\n";
    const provider = create(async () => response(body(keepalive.repeat(Math.ceil(9 * 1024 * 1024 / keepalive.length)), 65536)));
    expect(await provider.send(createNativeProviderRequest(provider), context(), { mode: "streaming", invocationId: "total" }))
      .toMatchObject({ kind: "failed", failure: { code: "provider_response_too_large" } });
  });
});

describe("protocol-specific stream assembly", () => {
  it("correlates interleaved OpenAI call fragments by index while preserving final call order", async () => {
    const value = sse({ tool_calls: [
      { index: 1, id: "second", type: "function", function: { name: "Search", arguments: "{\"query\":" } },
      { index: 0, id: "first", type: "function", function: { name: "Read", arguments: "{\"file_path\":" } },
    ] }) + sse({ tool_calls: [
      { index: 0, function: { arguments: "\"package.json\"}" } },
      { index: 1, function: { arguments: "\"main\"}" } },
    ] }, "tool_calls") + "data: [DONE]\n\n";
    const progress: ProviderDeliveryProgress[] = [];
    const provider = factories.openai(async () => response(body(value)));
    const result = await provider.send(createNativeProviderRequest(provider), context(), { mode: "streaming", invocationId: "interleaved",
      observer: { observe: (event) => { progress.push(event); } },
    });
    expect(result).toMatchObject({ kind: "succeeded", response: { turn: { assistant: { content: [
      { call: { name: "Read", input: call.arguments, ordinal: 0 } },
      { call: { name: "Search", input: { query: "main" }, ordinal: 1 } },
    ] } } } });
    expect(progress.at(-1)).toMatchObject({ kind: "settled", parts: [
      { partId: "call:0", contentBlockOrdinal: 0 }, { partId: "call:1", contentBlockOrdinal: 1 },
    ] });
  });

  it("preserves separate identical Ollama call occurrences and final non-newline NDJSON", async () => {
    const provider = factories.ollama(async () => response(body([
      ndjson({ done: false, message: { tool_calls: [{ function: call }, { function: call }] } }),
      JSON.stringify({ done: true, done_reason: "stop" }),
    ].join(""))));
    const result = await provider.send(createNativeProviderRequest(provider), context(), { mode: "streaming", invocationId: "calls" });
    expect(result).toMatchObject({ kind: "succeeded", response: { turn: { assistant: { content: [
      { call: { name: "Read", input: call.arguments } }, { call: { name: "Read", input: call.arguments } },
    ] } } } });
  });

  it.each(["missing_finish", "missing_done", "bad_arguments", "changed_id", "index_gap", "multiple_choices"])("rejects OpenAI %s", async (kind) => {
    let value = frames("openai").join("");
    if (kind === "missing_finish") value = sse({ content: "hello" }) + "data: [DONE]\n\n";
    if (kind === "missing_done") value = sse({ content: "hello" }, "stop");
    if (kind === "bad_arguments") value = sse({ tool_calls: [
      { index: 0, id: "call-1", type: "function", function: { name: "Read", arguments: "{missing: 1}" } },
    ] }, "tool_calls") + "data: [DONE]\n\n";
    if (kind === "changed_id") value = sse({ content: "a" }) + sse({ content: "b" }).replace("response-1", "response-2");
    if (kind === "index_gap") value = value.replaceAll('"index":0,"id":"call-1"', '"index":1,"id":"call-1"');
    if (kind === "multiple_choices") value = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {} }, { index: 1, delta: {} }] })}\n\n`;
    const provider = factories.openai(async () => response(body(value)));
    expect(await provider.send(createNativeProviderRequest(provider), context(), { mode: "streaming", invocationId: kind }))
      .toMatchObject({ kind: "failed" });
  });
});
