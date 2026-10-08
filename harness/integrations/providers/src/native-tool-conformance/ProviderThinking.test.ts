import { describe, expect, it } from "vitest";
import type { Provider, ModelMessage } from "@agent-anything/model-interaction";
import { OllamaProvider } from "../ollama/OllamaProvider.js";
import { OpenAICompatibleProvider } from "../openai-compatible/OpenAICompatibleProvider.js";
import { createNativeProviderRequest, createSettledToolResultMessage } from "./NativeToolInteractionTestSupport.js";
import type { FetchLike } from "../http/ProviderHttpTransport.js";

const limit = { maximumBytes: 1024 * 1024, source: "host_configured" as const, revision: "1" };
const context = { signal: new AbortController().signal, interruption: null };
describe.each(["ollama", "deepseek"] as const)("%s reasoning replay", service => {
  it("keeps text-only reasoning in the next accounted request", async () => {
    const bodies: Record<string, any>[] = [];
    const fetch: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => service === "ollama"
        ? { done: true, done_reason: "stop", message: { role: "assistant", content: "Answer", thinking: "Reasoning", tool_calls: [] } }
        : { id: "reply", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Answer", reasoning_content: "Reasoning" } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } } } };
    };
    const provider: Provider = service === "ollama" ? new OllamaProvider({ baseUrl: "http://localhost:11435", model: "model", timeoutMs: 1000,
      think: true, runtime: { contextWindowTokens: 16384, maximumOutputTokens: 2048 }, nativeToolInteraction: { supported: true }, requestBodyTransportLimit: limit }, fetch)
      : new OpenAICompatibleProvider({ baseUrl: "https://provider.test", apiKey: "secret", model: "model", timeoutMs: 1000,
        service: "deepseek", thinking: { type: "enabled" }, reasoningEffort: "high", maximumOutputTokens: 4096,
        nativeToolInteraction: { supported: true }, requestBodyTransportLimit: limit }, fetch);
    const result = await provider.send(createNativeProviderRequest(provider), context);
    expect(result.kind).toBe("succeeded");
    if (result.kind !== "succeeded" || result.response.kind !== "native_tool_turn") throw Error("Expected Turn");
    const assistant = result.response.turn.assistant;
    expect(assistant.reasoning?.text).toBe("Reasoning");
    expect(assistant.content).toEqual([{ kind: "text", text: "Answer" }]);
    const history: ModelMessage[] = [{ role: "user", content: [{ kind: "text", text: "Start" }] }, assistant,
      { role: "user", content: [{ kind: "text", text: "Continue" }] }];
    const request = createNativeProviderRequest(provider, { requestId: "request-2", messages: history });
    expect(JSON.stringify(request.composition)).toContain("Reasoning");
    expect((await provider.send(request, context)).kind).toBe("succeeded");
    expect(bodies[1]!.messages.find((message: any) => message.role === "assistant")).toMatchObject(service === "ollama"
      ? { thinking: "Reasoning", content: "Answer" } : { reasoning_content: "Reasoning", content: "Answer" });
    expect(bodies[1]).toMatchObject(service === "ollama" ? { think: true } : { thinking: { type: "enabled" }, reasoning_effort: "high" });
    if (service === "deepseek") expect(result.response.turn.usage).toMatchObject({ totalTokens: 5, outputTokens: 3, metadata: { reasoningTokens: 2 } });
    const foreign = { ...assistant, reasoning: { ...assistant.reasoning!, replay: { ...assistant.reasoning!.replay!, binding: "foreign" } } };
    const rejected = await provider.send(createNativeProviderRequest(provider, { messages: [foreign] }), context);
    expect(rejected).toMatchObject({ kind: "failed", failure: { code: "provider_input_encoding_invalid" } });
    expect(bodies).toHaveLength(2);
  });
  it("replays reasoning across a Tool result without changing call ordinals", async () => {
    const bodies: Record<string, any>[] = [];
    const fetch: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      const calls = bodies.length === 1 ? [{ id: "call-1", type: "function", function: {
        name: "Read", arguments: service === "ollama" ? { file_path: "file.txt" } : JSON.stringify({ file_path: "file.txt" }),
      } }] : [];
      return { ok: true, status: 200, json: async () => service === "ollama"
        ? { done: true, done_reason: "stop", message: { role: "assistant", content: calls.length ? "" : "Read completed", thinking: "Choose Read", tool_calls: calls } }
        : { id: "reply", choices: [{ finish_reason: calls.length ? "tool_calls" : "stop",
          message: { role: "assistant", content: calls.length ? "" : "Read completed", reasoning_content: "Choose Read", tool_calls: calls } }] } };
    };
    const provider: Provider = service === "ollama"
      ? new OllamaProvider({ baseUrl: "http://localhost:11435", model: "model", timeoutMs: 1000, think: true,
        runtime: { contextWindowTokens: 16384, maximumOutputTokens: 2048 }, nativeToolInteraction: { supported: true }, requestBodyTransportLimit: limit }, fetch)
      : new OpenAICompatibleProvider({ baseUrl: "https://provider.test", apiKey: "secret", model: "model", timeoutMs: 1000,
        service: "deepseek", thinking: { type: "enabled" }, maximumOutputTokens: 4096,
        nativeToolInteraction: { supported: true }, requestBodyTransportLimit: limit }, fetch);
    const first = await provider.send(createNativeProviderRequest(provider, { instructions: { content: [] } }), context);
    if (first.kind !== "succeeded" || first.response.kind !== "native_tool_turn") throw Error("Expected Tool Turn");
    const assistant = first.response.turn.assistant;
    const block = assistant.content[0];
    if (block?.kind !== "model_tool_call") throw Error("Expected first call");
    expect(assistant.reasoning?.text).toBe("Choose Read");
    const request = createNativeProviderRequest(provider, { instructions: { content: [] }, messages: [
      { role: "user", content: [{ kind: "text", text: "Read file.txt" }] }, assistant, createSettledToolResultMessage(block.call),
    ] });
    expect((await provider.send(request, context)).kind).toBe("succeeded");
    expect(bodies[1]!.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(bodies[1]!.messages[1]).toMatchObject(service === "ollama" ? { thinking: "Choose Read" } : { reasoning_content: "Choose Read" });
    expect(bodies[1]!.messages[1].tool_calls).toHaveLength(1);
    if (service === "deepseek") {
      const { reasoning: _reasoning, ...missing } = assistant;
      const invalid = createNativeProviderRequest(provider, { messages: [missing, createSettledToolResultMessage(block.call)] });
      expect(await provider.send(invalid, context)).toMatchObject({ kind: "failed", failure: { code: "provider_input_encoding_invalid" } });
      expect(bodies).toHaveLength(2);
    }
  });
});
