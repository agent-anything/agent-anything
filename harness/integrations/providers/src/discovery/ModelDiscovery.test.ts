import { describe, expect, it, vi } from "vitest";
import { discoverOllamaModels } from "../ollama/OllamaModelDiscovery.js";
import { discoverChatCompletionModels } from "../openai-compatible/ChatCompletionModelDiscovery.js";

describe("model discovery", () => {
  it("keeps runtime allocation observations separate from advertised model capacity", async () => {
    const fetch = async (url: string) => Response.json(url.endsWith("tags") ? {models: [{name: "m", digest: "sha256:m"}]}
      : url.endsWith("show") ? {model_info: {"m.context_length": 131072}, template: "template"}
      : url.endsWith("version") ? {version: "0.35.1"} : {models: [{name: "m", digest: "sha256:m", context_length: 16384}]});
    const result = await discoverOllamaModels({baseUrl: "http://localhost:11435", model: "m", includeRuntimeContext: true}, fetch);
    expect(result.models[0]).toMatchObject({contextWindowTokens: 131072,
      contextEvidence: {runtimeVersion: "0.35.1", loadedContextWindowTokens: 16384, templateDigest: expect.stringMatching(/^sha256:/)}});
  });
  it("queries Ollama booleans without manufacturing effort levels", async () => {
    const fetch = vi.fn(async (url: string) => Response.json(url.endsWith("tags") ? { models: [{ name: "model", digest: "sha256:artifact" }] }
      : { thinking: { values: [false, true], default: true }, model_info: { "architecture.context_length": 131072 } }));
    const result = await discoverOllamaModels({ baseUrl: "http://localhost:11435", model: "model" }, fetch as typeof globalThis.fetch);
    expect(result.models[0]).toMatchObject({ artifact: "sha256:artifact", contextWindowTokens: 131072, thinking: { values: [false, true], defaultValue: true, source: "endpoint" } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not guess from capability labels when thinking metadata is absent", async () => {
    const fetch = async (url: string) => Response.json(url.endsWith("tags") ? { models: [{ name: "model" }] } : { capabilities: ["thinking"] });
    const result = await discoverOllamaModels({ baseUrl: "http://localhost:11435", model: "model" }, fetch as typeof globalThis.fetch);
    expect(result.models[0]?.thinking.status).toBe("unknown");
  });
  it("uses DeepSeek endpoint levels and keeps generic compatible support unknown", async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{ id: "new-model", effort: { supported_levels: ["custom", "max"], default_level: "custom" } }] }));
    const input = { baseUrl: "https://provider.test/v1", apiKey: "key" };
    const deepseek = await discoverChatCompletionModels({ ...input, service: "deepseek" }, fetch);
    expect(deepseek.models[0]?.thinking).toMatchObject({ values: [false, true, "custom", "max"], defaultValue: "custom" });
    expect((await discoverChatCompletionModels({ ...input, service: "generic" }, fetch)).models[0]?.thinking.status).toBe("unknown");
  });
  it("rejects inconsistent metadata and bounded HTTP failures without exposing response bodies", async () => {
    const fetch = async () => Response.json({ data: [{ id: "model", effort: { supported_levels: ["high"], default_level: "missing" } }] });
    await expect(discoverChatCompletionModels({ baseUrl: "https://provider.test", apiKey: "", service: "deepseek" }, fetch)).rejects.toThrow();
    await expect(discoverChatCompletionModels({ baseUrl: "https://provider.test", apiKey: "secret", service: "generic" }, async () => new Response("secret", { status: 401 }))).rejects.toThrow("HTTP 401");
  });
});
