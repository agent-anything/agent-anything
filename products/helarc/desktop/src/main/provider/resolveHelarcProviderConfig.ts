import {
  createHelarcProviderProfile,
  type HelarcOllamaRuntimeProfile,
  type HelarcProviderKind,
  type HelarcProviderProfile,
} from "@agent-anything/helarc/configuration";
import type { HelarcModelUsePolicy } from "@agent-anything/helarc/configuration";
import {
  HELARC_DEFAULT_OLLAMA_RUNTIME_PROFILE,
  HELARC_DEFAULT_PROVIDER_SETTINGS,
} from "../../shared/HelarcDesktopApi.js";

export interface HelarcProviderConfig {
  providerKind: HelarcProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  ollamaRuntime: Readonly<HelarcOllamaRuntimeProfile> | null;
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
  const providerKind = readProviderKind(env);
  const baseUrl = readEnv(env, "HELARC_PROVIDER_BASE_URL") ??
    (providerKind === HELARC_DEFAULT_PROVIDER_SETTINGS.providerKind
      ? HELARC_DEFAULT_PROVIDER_SETTINGS.baseUrl
      : undefined);
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
  const ollamaRuntime = readOllamaRuntime(env, providerKind);
  const qualificationPolicy = readQualificationPolicy(env);
  if (qualificationPolicy === null || (providerKind === "ollama" && ollamaRuntime === null)) {
    return {
      ok: false,
      error: {
        code: "provider_config_invalid",
        message: "Provider configuration is invalid.",
        missingKeys: [],
      },
    };
  }
  const profileResult = createHelarcProviderProfile({
    id: "env-provider",
    providerKind,
    displayName: "Environment Provider",
    baseUrl,
    model,
    timeoutMs,
    ollamaRuntime,
    credentialStatus: apiKey.length > 0 ? "present" : "empty_allowed",
    qualificationPolicy,
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
      providerKind,
      baseUrl,
      apiKey,
      model,
      timeoutMs,
      ollamaRuntime,
    },
    profile: profileResult.profile,
  };
}

function readOllamaRuntime(
  env: NodeJS.ProcessEnv,
  providerKind: HelarcProviderKind,
): Readonly<HelarcOllamaRuntimeProfile> | null {
  if (providerKind !== "ollama") return null;
  const contextWindowTokens = readPositiveInteger(
    env,
    "HELARC_OLLAMA_CONTEXT_WINDOW_TOKENS",
    HELARC_DEFAULT_OLLAMA_RUNTIME_PROFILE.contextWindowTokens,
  );
  const maximumOutputTokens = readPositiveInteger(
    env,
    "HELARC_OLLAMA_MAXIMUM_OUTPUT_TOKENS",
    HELARC_DEFAULT_OLLAMA_RUNTIME_PROFILE.maximumOutputTokens,
  );
  return contextWindowTokens === null || maximumOutputTokens === null ||
      maximumOutputTokens >= contextWindowTokens
    ? null
    : Object.freeze({ contextWindowTokens, maximumOutputTokens });
}

function readPositiveInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
): number | null {
  const raw = readEnv(env, key);
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function readQualificationPolicy(
  env: NodeJS.ProcessEnv,
): HelarcModelUsePolicy | null {
  const value = readEnv(env, "HELARC_MODEL_QUALIFICATION_POLICY");
  if (value === undefined) return HELARC_DEFAULT_PROVIDER_SETTINGS.qualificationPolicy;
  return value === "require_qualified" || value === "allow_experimental" ? value : null;
}

function readProviderKind(env: NodeJS.ProcessEnv): HelarcProviderKind {
  const value = readEnv(env, "HELARC_PROVIDER_KIND");
  if (value === "openai-compatible" || value === "ollama") return value;
  return HELARC_DEFAULT_PROVIDER_SETTINGS.providerKind;
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = readEnv(env, "HELARC_PROVIDER_TIMEOUT_MS");
  if (!raw) {
    return HELARC_DEFAULT_PROVIDER_SETTINGS.timeoutMs;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : HELARC_DEFAULT_PROVIDER_SETTINGS.timeoutMs;
}
