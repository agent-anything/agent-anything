export interface HelarcProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface HelarcProviderConfigError {
  code: "provider_config_missing";
  message: string;
  missingKeys: string[];
}

export type ResolveHelarcProviderConfigResult =
  | { ok: true; config: HelarcProviderConfig }
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

  return {
    ok: true,
    config: {
      baseUrl,
      apiKey: readEnv(env, "HELARC_PROVIDER_API_KEY") ?? "",
      model,
      timeoutMs: readTimeoutMs(env),
    },
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
