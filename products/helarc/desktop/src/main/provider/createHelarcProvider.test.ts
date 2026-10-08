import { describe, expect, it } from "vitest";
import { createHelarcProvider } from "./createHelarcProvider.js";

const settings = {
  providerKind: "openai-compatible" as const, displayName: "DeepSeek",
  baseUrl: "https://api.deepseek.com", model: "deepseek-flash", apiKey: "test-secret",
  timeoutMs: 120_000, ollamaRuntime: null,
};

describe("Desktop Provider composition", () => {
  it.each(["https://api.deepseek.com", "https://api.deepseek.com/", "https://api.deepseek.com/v1/"])(
    "selects explicit non-thinking mode for %s", baseUrl => {
      const provider = createHelarcProvider({ ...settings, baseUrl, modelSettings: { service: "deepseek", thinking: { mode: "disabled" }, maximumOutputTokens: 4096 } });
      expect(provider.descriptor.metadata.generationConfiguration).toEqual({
        maximumOutputTokens: 4096, thinking: { type: "disabled" }, service: "deepseek", reasoningEffort: null,
      });
      expect(JSON.stringify(provider.descriptor)).not.toContain(settings.apiKey);
    },
  );

  it.each(["https://provider.example/v1", "https://api.deepseek.com.example", "https://api.deepseek.com/beta", "https://api.deepseek.com:8443"])(
    "does not assume extension support on %s", baseUrl => {
      expect(createHelarcProvider({ ...settings, baseUrl }).descriptor.metadata.generationConfiguration)
        .toMatchObject({ thinking: null });
    },
  );

  it("does not alter Ollama generation configuration", () => {
    const provider = createHelarcProvider({ ...settings, providerKind: "ollama", baseUrl: "http://localhost:11435",
      model: "gemma4:e4b", apiKey: "", ollamaRuntime: { contextWindowTokens: 163840, maximumOutputTokens: 2048 } });
    expect(provider.descriptor.id).toBe("ollama.api");
    expect(provider.descriptor.metadata.generationConfiguration).toEqual({ think: null, modelArtifact: null, maximumOutputTokens: 2048 });
    expect(provider.modelContext.requestedOutput.maximum).toBe(2048);
  });
});
