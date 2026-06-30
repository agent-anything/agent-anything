import { createHelarcProviderProfile, type HelarcProviderProfile } from "@agent-anything/helarc";

export interface HelarcProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export type HelarcProviderConfigErrorCode =
  | "provider_config_missing"
  | "provider_config_invalid";

export interface HelarcProviderConfigError {
  code: HelarcProviderConfigErrorCode;
  message: string;
  missingKeys: string[];
}

export type ResolveHelarcProviderConfigResult =
  | { ok: true; config: HelarcProviderConfig; profile: HelarcProviderProfile }
  | { ok: false; error: HelarcProviderConfigError };

export function resolveHelarcProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolveHelarcProviderConfigResult {
  const baseUrl = readEnv(env, "HELARC_PROVIDER_BASE_URL");
  const model = readEnv(env, "HELARC_PROVIDER_MODEL");
  const missingKeys = [
    baseUrl ? null : "HELARC_PROVIDER_BASE_URL",
    model ? null : "HELARC_PROVIDER_MODEL",
  ].filter((key): key is string => key !== null);

  if (!baseUrl || !model) {
    return {
      ok: false,
      error: {
        code: "provider_config_missing",
        message: "Provider configuration is incomplete.",
        missingKeys,
      },
    };
  }

  const apiKey = readEnv(env, "HELARC_PROVIDER_API_KEY") ?? "";
  const timeoutMs = readTimeoutMs(env);
  const profileResult = createHelarcProviderProfile({
    id: "env-provider",
    displayName: "Environment Provider",
    baseUrl,
    model,
    timeoutMs,
    credentialStatus: apiKey.length > 0 ? "present" : "empty_allowed",
    isActive: true,
  });

  if (!profileResult.ok) {
    return {
      ok: false,
      error: {
        code: "provider_config_invalid",
        message: "Provider configuration is invalid.",
        missingKeys: [],
      },
    };
  }

  return {
    ok: true,
    config: {
      baseUrl,
      apiKey,
      model,
      timeoutMs,
    },
    profile: profileResult.profile,
  };
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = readEnv(env, "HELARC_PROVIDER_TIMEOUT_MS");
  if (!raw) {
    return 30_000;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}
