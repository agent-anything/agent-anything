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
        baseUrl: "https://provider.local/v1",
        apiKey: "secret-key",
        model: "model-a",
        timeoutMs: 1500,
      },
      profile: {
        id: "env-provider",
        displayName: "Environment Provider",
        endpointLabel: "provider.local",
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
      profile: {
        credentialStatus: "empty_allowed",
        baseUrlOrigin: "http://127.0.0.1:11434",
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
