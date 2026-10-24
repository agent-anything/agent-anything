import {describe, expect, it} from "vitest";
import {OllamaProvider} from "../ollama/OllamaProvider.js";
import {OpenAICompatibleProvider} from "../openai-compatible/OpenAICompatibleProvider.js";
import {createNativeProviderRequest} from "../native-tool-conformance/NativeToolInteractionTestSupport.js";
import {normalizedUsageMetadata} from "./ProviderInputAccounting.js";
import {nativeInputAccounting} from "./ProviderInputAccounting.js";
const config = {baseUrl: "http://localhost:11435", model: "model", timeoutMs: 1000, runtime: {contextWindowTokens: 163840},
  nativeToolInteraction: {supported: true}, requestBodyTransportLimit: {maximumBytes: 1000000, source: "host_configured" as const, revision: "1"}};
describe("provider input accounting", () => {
  it("reuses only the complete derived input footprint while re-encoding every use", () => {
    let content = "one", encodes = 0;
    const accounting = nativeInputAccounting({basis: {adapter: "fixture"}, inputUsage: "complete", outputUsage: "complete",
      defaultGenerationRoom: null, limitations: [], encode: () => {encodes++; return JSON.stringify({messages: [{role: "user", content}]});}});
    const composition = createNativeProviderRequest(new OllamaProvider(config)).composition;
    const first = accounting.project(composition);
    expect(accounting.project(composition)).toBe(first);
    content = "two";
    expect(accounting.project(composition).digest).not.toBe(first.digest);
    expect(encodes).toBe(3);
  });
  it("uses the actual native input projection, excluding transport and credentials", async () => {
    let body: Record<string, unknown> = {};
    const provider = new OllamaProvider({...config, runtime: {contextWindowTokens: 163840}}, async (_, init) => {
      body = JSON.parse(init.body);
      return {ok: true, status: 200, json: async () => ({done: true, done_reason: "stop", model: "model",
        message: {role: "assistant", content: "done"}, prompt_eval_count: 100, prompt_eval_cached_count: 80, eval_count: 20})};
    });
    const request = createNativeProviderRequest(provider);
    const footprint = provider.modelContext.accounting!.project(request.composition);
    const result = await provider.send(request, {signal: new AbortController().signal, interruption: null});
    expect(result.kind).toBe("succeeded");
    expect(body).toMatchObject({truncate: false, shift: false, options: {num_ctx: 163840}});
    expect(body.options).not.toHaveProperty("num_predict");
    expect(footprint.bytes).toBe(Buffer.byteLength(JSON.stringify({messages: body.messages, tools: body.tools})));
    expect(footprint.bindingBytes).toBeGreaterThan(0);
    if (result.kind === "succeeded" && result.response.kind === "native_tool_turn") {
      expect(result.response.turn.usage).toMatchObject({inputTokens: 100, outputTokens: 20, totalTokens: 120,
        metadata: {cachedInputTokens: 80, uncachedInputTokens: null, accountingConsistent: true}});
    }
  });
  it("does not infer official service facts from the model name or selected service on another URL", () => {
    const provider = (baseUrl: string, service: "generic" | "deepseek" = "deepseek") => new OpenAICompatibleProvider({...config,
      apiKey: "secret", model: "deepseek-flash", baseUrl, service,
      ...(service === "deepseek" ? {thinking: {type: "disabled" as const}} : {})});
    const official = provider("https://api.deepseek.com/v1");
    expect(official.modelContext.capacity).toMatchObject({supported: true});
    expect(official.modelContext.accounting?.defaultGenerationRoom).toBe(8192);
    expect(official.modelContext.requestedOutput.maximum).toBeNull();
    for (const other of [provider("https://proxy.example/v1"), provider("https://api.deepseek.com", "generic")]) {
      expect(other.modelContext.accounting?.defaultGenerationRoom).toBeNull();
      expect(other.modelContext.accounting?.inputUsage).toBe("unknown");
      expect(other.modelContext.capacity.supported).toBe(false);
    }
    expect(JSON.stringify(official.modelContext.accounting)).not.toContain("secret");
  });
  it("retains missing and inconsistent cache counters without inventing an inclusive total", () => {
    expect(normalizedUsageMetadata({input: 100, output: 20, cached: undefined, revision: "test", raw: {}})).toMatchObject({cachedInputTokens: null});
    expect(normalizedUsageMetadata({input: 100, output: 20, cached: 60, uncached: 40, revision: "test", raw: {}}))
      .toMatchObject({cachedInputTokens: 60, uncachedInputTokens: 40, accountingConsistent: true});
    expect(normalizedUsageMetadata({input: 100, output: 20, cached: 101, revision: "test", raw: {}})).toMatchObject({accountingConsistent: false});
  });
});
