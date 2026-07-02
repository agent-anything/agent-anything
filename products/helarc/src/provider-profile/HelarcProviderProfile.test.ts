import { describe, expect, it } from "vitest";
import {
  createHelarcProviderProfile,
  selectHelarcProviderProfile,
} from "./index.js";

describe("createHelarcProviderProfile", () => {
  it("creates safe provider profile metadata without secrets", () => {
    const result = createHelarcProviderProfile({
      id: " local ",
      displayName: " Local Model ",
      baseUrl: " https://provider.local/v1/chat/completions ",
      model: " model-a ",
      timeoutMs: 1500,
      credentialStatus: "present",
      isActive: true,
    });

    expect(result).toEqual({
      ok: true,
      profile: {
        id: "local",
        displayName: "Local Model",
        endpointLabel: "provider.local",
        baseUrl: "https://provider.local/v1/chat/completions",
        baseUrlOrigin: "https://provider.local",
        model: "model-a",
        timeoutMs: 1500,
        credentialStatus: "present",
        isActive: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("allows explicit empty credential status for trusted local endpoints", () => {
    const result = createHelarcProviderProfile({
      id: "local",
      displayName: "Local Model",
      baseUrl: "http://localhost:11434/v1",
      model: "local-model",
      timeoutMs: 30_000,
      credentialStatus: "empty_allowed",
    });

    expect(result).toMatchObject({
      ok: true,
      profile: {
        baseUrl: "http://localhost:11434/v1",
        baseUrlOrigin: "http://localhost:11434",
        credentialStatus: "empty_allowed",
        isActive: false,
      },
    });
  });

  it("rejects remote HTTP provider endpoints", () => {
    const result = createHelarcProviderProfile({
      id: "remote",
      displayName: "Remote Provider",
      baseUrl: "http://provider.example/v1",
      model: "model-a",
      timeoutMs: 1000,
      credentialStatus: "present",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider_profile_base_url_invalid",
        message: "Provider profile base URL must use HTTPS unless it targets localhost.",
      },
    });
  });

  it("rejects invalid profile metadata", () => {
    const result = createHelarcProviderProfile({
      id: "profile-1",
      displayName: "Provider",
      baseUrl: "file:///tmp/provider",
      model: "model-a",
      timeoutMs: 1000,
      credentialStatus: "present",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider_profile_base_url_invalid",
        message: "Provider profile base URL must use HTTP or HTTPS.",
      },
    });
  });
});

describe("selectHelarcProviderProfile", () => {
  it("marks only the selected profile as active", () => {
    const first = createHelarcProviderProfile({
      id: "first",
      displayName: "First",
      baseUrl: "https://first.local/v1",
      model: "model-a",
      timeoutMs: 1000,
      credentialStatus: "present",
      isActive: true,
    });
    const second = createHelarcProviderProfile({
      id: "second",
      displayName: "Second",
      baseUrl: "https://second.local/v1",
      model: "model-b",
      timeoutMs: 1000,
      credentialStatus: "missing",
    });
    if (!first.ok || !second.ok) {
      throw new Error("Expected valid profiles.");
    }

    const result = selectHelarcProviderProfile(
      [first.profile, second.profile],
      "second",
    );

    expect(result).toMatchObject({
      ok: true,
      activeProfile: {
        id: "second",
        isActive: true,
      },
      profiles: [
        { id: "first", isActive: false },
        { id: "second", isActive: true },
      ],
    });
  });
});
