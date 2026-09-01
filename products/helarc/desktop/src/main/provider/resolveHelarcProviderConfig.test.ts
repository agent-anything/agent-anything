import { describe, expect, it } from "vitest";
import { resolveHelarcProviderConfig } from "./resolveHelarcProviderConfig.js";

describe("resolveHelarcProviderConfig", () => {
  it("resolves required provider config from environment", () => {
    const result = resolveHelarcProviderConfig({
      HELARC_PROVIDER_KIND: "openai-compatible",
      HELARC_PROVIDER_BASE_URL: " https://provider.local/v1 ",
      HELARC_PROVIDER_API_KEY: " secret-key ",
      HELARC_PROVIDER_MODEL: " model-a ",
      HELARC_PROVIDER_TIMEOUT_MS: "1500",
      HELARC_MODEL_QUALIFICATION_POLICY: "require_qualified",
    });

    expect(result).toEqual({
      ok: true,
      config: {
        providerKind: "openai-compatible",
        baseUrl: "https://provider.local/v1",
        apiKey: "secret-key",
        model: "model-a",
        timeoutMs: 1500,
        ollamaRuntime: null,
      },
      profile: {
        id: "env-provider",
        providerKind: "openai-compatible",
        displayName: "Environment Provider",
        endpointLabel: "provider.local",
        baseUrl: "https://provider.local/v1",
        baseUrlOrigin: "https://provider.local",
        model: "model-a",
        timeoutMs: 1500,
        ollamaRuntime: null,
        credentialStatus: "present",
        qualificationPolicy: "require_qualified",
        isActive: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("chat/completions");
  });

  it("returns a safe missing configuration error", () => {
    const result = resolveHelarcProviderConfig({
      HELARC_PROVIDER_API_KEY: "secret-key",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider_config_missing",
        message: "Provider configuration is incomplete.",
        missingKeys: ["HELARC_PROVIDER_MODEL"],
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("maps empty API keys to empty-allowed credential status", () => {
    const result = resolveHelarcProviderConfig({
      HELARC_PROVIDER_KIND: "openai-compatible",
      HELARC_PROVIDER_BASE_URL: "http://127.0.0.1:11434/v1",
      HELARC_PROVIDER_MODEL: "local-model",
    });

    expect(result).toMatchObject({
      ok: true,
      config: {
        providerKind: "openai-compatible",
      },
      profile: {
        providerKind: "openai-compatible",
        credentialStatus: "empty_allowed",
        baseUrlOrigin: "http://127.0.0.1:11434",
      },
    });
  });

  it("uses the local Ollama defaults when only the model is configured", () => {
    const result = resolveHelarcProviderConfig({
      HELARC_PROVIDER_MODEL: "gemma3:4b",
    });

    expect(result).toMatchObject({
      ok: true,
      config: {
        providerKind: "ollama",
        baseUrl: "http://localhost:11434",
        apiKey: "",
        model: "gemma3:4b",
        timeoutMs: 300_000_000,
        ollamaRuntime: {
          contextWindowTokens: 16_384,
          maximumOutputTokens: 2_048,
        },
      },
      profile: {
        providerKind: "ollama",
        baseUrl: "http://localhost:11434/",
        baseUrlOrigin: "http://localhost:11434",
        credentialStatus: "empty_allowed",
        qualificationPolicy: "allow_experimental",
        timeoutMs: 300_000_000,
        ollamaRuntime: {
          contextWindowTokens: 16_384,
          maximumOutputTokens: 2_048,
        },
      },
    });
  });

  it("resolves explicit Ollama runtime limits from environment", () => {
    const result = resolveHelarcProviderConfig({
      HELARC_PROVIDER_KIND: "ollama",
      HELARC_PROVIDER_BASE_URL: "http://localhost:11434",
      HELARC_PROVIDER_MODEL: "gemma4:e4b",
      HELARC_OLLAMA_CONTEXT_WINDOW_TOKENS: "32768",
      HELARC_OLLAMA_MAXIMUM_OUTPUT_TOKENS: "4096",
    });

    expect(result).toMatchObject({
      ok: true,
      config: {
        ollamaRuntime: {
          contextWindowTokens: 32_768,
          maximumOutputTokens: 4_096,
        },
      },
    });
  });

  it("rejects invalid Ollama runtime limits instead of using server defaults", () => {
    const result = resolveHelarcProviderConfig({
      HELARC_PROVIDER_KIND: "ollama",
      HELARC_PROVIDER_BASE_URL: "http://localhost:11434",
      HELARC_PROVIDER_MODEL: "gemma4:e4b",
      HELARC_OLLAMA_CONTEXT_WINDOW_TOKENS: "4096",
      HELARC_OLLAMA_MAXIMUM_OUTPUT_TOKENS: "4096",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider_config_invalid",
        message: "Provider configuration is invalid.",
        missingKeys: [],
      },
    });
  });

  it("accepts explicit strict model qualification", () => {
    const result = resolveHelarcProviderConfig({
      HELARC_PROVIDER_KIND: "ollama",
      HELARC_PROVIDER_BASE_URL: "http://localhost:11434",
      HELARC_PROVIDER_MODEL: "gemma4:e4b",
      HELARC_MODEL_QUALIFICATION_POLICY: "require_qualified",
    });

    expect(result).toMatchObject({
      ok: true,
      profile: {
        qualificationPolicy: "require_qualified",
      },
    });
  });

  it("rejects an unknown model qualification policy instead of defaulting", () => {
    const result = resolveHelarcProviderConfig({
      HELARC_PROVIDER_BASE_URL: "https://provider.local/v1",
      HELARC_PROVIDER_MODEL: "model-a",
      HELARC_MODEL_QUALIFICATION_POLICY: "permissive",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider_config_invalid",
        message: "Provider configuration is invalid.",
        missingKeys: [],
      },
    });
  });

  it("returns a safe invalid configuration error", () => {
    const result = resolveHelarcProviderConfig({
      HELARC_PROVIDER_BASE_URL: "file:///tmp/provider",
      HELARC_PROVIDER_API_KEY: "secret-key",
      HELARC_PROVIDER_MODEL: "model-a",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider_config_invalid",
        message: "Provider configuration is invalid.",
        missingKeys: [],
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-key");
    expect(JSON.stringify(result)).not.toContain("file:///tmp/provider");
  });
});
