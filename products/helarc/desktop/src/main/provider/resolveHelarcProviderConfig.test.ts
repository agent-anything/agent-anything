import { describe, expect, it } from "vitest";
import { resolveHelarcProviderConfig } from "./resolveHelarcProviderConfig.js";

describe("resolveHelarcProviderConfig", () => {
  it("resolves required provider config from environment", () => {
    const result = resolveHelarcProviderConfig({
      HELARC_PROVIDER_BASE_URL: " https://provider.local/v1 ",
      HELARC_PROVIDER_API_KEY: " secret-key ",
      HELARC_PROVIDER_MODEL: " model-a ",
      HELARC_PROVIDER_TIMEOUT_MS: "1500",
    });

    expect(result).toEqual({
      ok: true,
      config: {
        providerKind: "openai-compatible",
        baseUrl: "https://provider.local/v1",
        apiKey: "secret-key",
        model: "model-a",
        timeoutMs: 1500,
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
        credentialStatus: "present",
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
        missingKeys: ["HELARC_PROVIDER_BASE_URL", "HELARC_PROVIDER_MODEL"],
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("maps empty API keys to empty-allowed credential status", () => {
    const result = resolveHelarcProviderConfig({
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

  it("resolves Ollama provider kind from environment", () => {
    const result = resolveHelarcProviderConfig({
      HELARC_PROVIDER_KIND: "ollama",
      HELARC_PROVIDER_BASE_URL: "http://localhost:11434",
      HELARC_PROVIDER_MODEL: "gemma3:4b",
    });

    expect(result).toMatchObject({
      ok: true,
      config: {
        providerKind: "ollama",
        baseUrl: "http://localhost:11434",
        apiKey: "",
        model: "gemma3:4b",
      },
      profile: {
        providerKind: "ollama",
        baseUrl: "http://localhost:11434/",
        baseUrlOrigin: "http://localhost:11434",
        credentialStatus: "empty_allowed",
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
