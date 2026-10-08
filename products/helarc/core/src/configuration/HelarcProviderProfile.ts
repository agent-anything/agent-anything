import { snapshotModelThinkingSelection, type ModelThinkingSelection } from "@agent-anything/model-interaction";

export type HelarcProviderCredentialStatus =
  | "present"
  | "empty_allowed"
  | "missing";

export type HelarcProviderKind =
  | "openai-compatible"
  | "ollama";

export type HelarcModelUsePolicy =
  | "require_qualified"
  | "allow_experimental";

export interface HelarcOllamaRuntimeProfile {
  contextWindowTokens: number;
  maximumOutputTokens: number;
}

export interface CreateHelarcProviderProfileInput {
  modelSettings?: HelarcProviderModelSettings;
  revision?: string;
  id: string;
  providerKind?: HelarcProviderKind;
  displayName: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  ollamaRuntime?: HelarcOllamaRuntimeProfile | null;
  credentialStatus: HelarcProviderCredentialStatus;
  qualificationPolicy?: HelarcModelUsePolicy;
  isActive?: boolean;
}

export interface HelarcProviderProfile {
  modelSettings?: HelarcProviderModelSettings;
  revision?: string;
  id: string;
  providerKind: HelarcProviderKind;
  displayName: string;
  endpointLabel: string;
  baseUrl: string;
  baseUrlOrigin: string;
  model: string;
  timeoutMs: number;
  ollamaRuntime: Readonly<HelarcOllamaRuntimeProfile> | null;
  credentialStatus: HelarcProviderCredentialStatus;
  qualificationPolicy: HelarcModelUsePolicy;
  isActive: boolean;
}

export type HelarcProviderProfileErrorCode =
  | "provider_profile_id_required"
  | "provider_profile_display_name_required"
  | "provider_profile_base_url_required"
  | "provider_profile_base_url_invalid"
  | "provider_profile_model_required"
  | "provider_profile_timeout_invalid"
  | "provider_profile_ollama_runtime_invalid"
  | "provider_profile_credential_status_invalid"
  | "provider_profile_qualification_policy_invalid"
  | "provider_profile_kind_invalid"
  | "provider_profile_not_found";

export interface HelarcProviderProfileError {
  code: HelarcProviderProfileErrorCode;
  message: string;
}

export type CreateHelarcProviderProfileResult =
  | { ok: true; profile: HelarcProviderProfile }
  | { ok: false; error: HelarcProviderProfileError };

export type SelectHelarcProviderProfileResult =
  | { ok: true; profiles: HelarcProviderProfile[]; activeProfile: HelarcProviderProfile }
  | { ok: false; error: HelarcProviderProfileError };

export function createHelarcProviderProfile(
  input: CreateHelarcProviderProfileInput,
): CreateHelarcProviderProfileResult {
  const id = input.id.trim();
  if (id.length === 0) {
    return reject("provider_profile_id_required", "Provider profile id is required.");
  }

  const providerKind = input.providerKind ?? "openai-compatible";
  if (!isProviderKind(providerKind)) {
    return reject(
      "provider_profile_kind_invalid",
      "Provider profile kind is invalid.",
    );
  }

  const displayName = input.displayName.trim();
  if (displayName.length === 0) {
    return reject(
      "provider_profile_display_name_required",
      "Provider profile display name is required.",
    );
  }

  const urlResult = normalizeBaseUrl(input.baseUrl);
  if (!urlResult.ok) {
    return urlResult;
  }

  const model = input.model.trim();

  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    return reject(
      "provider_profile_timeout_invalid",
      "Provider profile timeout must be a positive number.",
    );
  }

  const ollamaRuntimeResult = normalizeOllamaRuntime(
    providerKind,
    input.ollamaRuntime,
  );
  if (!ollamaRuntimeResult.ok) {
    return ollamaRuntimeResult;
  }

  if (!isCredentialStatus(input.credentialStatus)) {
    return reject(
      "provider_profile_credential_status_invalid",
      "Provider profile credential status is invalid.",
    );
  }

  const qualificationPolicy = input.qualificationPolicy ?? "require_qualified";
  if (!isQualificationPolicy(qualificationPolicy)) {
    return reject(
      "provider_profile_qualification_policy_invalid",
      "Provider profile model qualification policy is invalid.",
    );
  }

  let modelSettings: HelarcProviderModelSettings;
  try { modelSettings = snapshotHelarcProviderModelSettings(input.modelSettings, providerKind); }
  catch { return reject("provider_profile_kind_invalid", "Provider model settings are invalid."); }
  if (!model && modelSettings.thinking.mode !== "default") {
    return reject("provider_profile_model_required", "Select a model before configuring thinking.");
  }

  return {
    ok: true,
    profile: {
      id,
      modelSettings,
      ...(input.revision === undefined ? {} : { revision: input.revision }),
      providerKind,
      displayName,
      endpointLabel: urlResult.url.host,
      baseUrl: urlResult.url.toString(),
      baseUrlOrigin: urlResult.url.origin,
      model,
      timeoutMs: input.timeoutMs,
      ollamaRuntime: ollamaRuntimeResult.runtime,
      credentialStatus: input.credentialStatus,
      qualificationPolicy,
      isActive: input.isActive ?? false,
    },
  };
}

function normalizeOllamaRuntime(
  providerKind: HelarcProviderKind,
  value: HelarcOllamaRuntimeProfile | null | undefined,
):
  | { ok: true; runtime: Readonly<HelarcOllamaRuntimeProfile> | null }
  | { ok: false; error: HelarcProviderProfileError } {
  if (providerKind !== "ollama") {
    return value === undefined || value === null
      ? { ok: true, runtime: null }
      : reject(
          "provider_profile_ollama_runtime_invalid",
          "Ollama runtime settings are only valid for an Ollama profile.",
        );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isSafeInteger(value.contextWindowTokens) ||
    value.contextWindowTokens <= 0 ||
    !Number.isSafeInteger(value.maximumOutputTokens) ||
    value.maximumOutputTokens <= 0 ||
    value.maximumOutputTokens >= value.contextWindowTokens
  ) {
    return reject(
      "provider_profile_ollama_runtime_invalid",
      "Ollama runtime settings must contain a positive context window and a smaller positive output limit.",
    );
  }
  return {
    ok: true,
    runtime: Object.freeze({
      contextWindowTokens: value.contextWindowTokens,
      maximumOutputTokens: value.maximumOutputTokens,
    }),
  };
}

function isQualificationPolicy(
  value: unknown,
): value is HelarcModelUsePolicy {
  return value === "require_qualified" || value === "allow_experimental";
}

export function selectHelarcProviderProfile(
  profiles: readonly HelarcProviderProfile[],
  activeProfileId: string,
): SelectHelarcProviderProfileResult {
  const normalizedId = activeProfileId.trim();
  const activeProfile = profiles.find((profile) => profile.id === normalizedId);
  if (!activeProfile) {
    return reject("provider_profile_not_found", "Provider profile was not found.");
  }

  const selectedProfiles = profiles.map((profile) => ({
    ...profile,
    isActive: profile.id === normalizedId,
  }));

  return {
    ok: true,
    profiles: selectedProfiles,
    activeProfile: {
      ...activeProfile,
      isActive: true,
    },
  };
}

function isProviderKind(value: unknown): value is HelarcProviderKind {
  return value === "openai-compatible" || value === "ollama";
}

function normalizeBaseUrl(
  value: string,
): { ok: true; url: URL } | { ok: false; error: HelarcProviderProfileError } {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return reject(
      "provider_profile_base_url_required",
      "Provider profile base URL is required.",
    );
  }

  try {
    const url = new URL(normalized);
    if (url.username || url.password || url.search || url.hash) return reject("provider_profile_base_url_invalid", "Provider URL cannot contain credentials, a query, or a fragment.");
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return reject(
        "provider_profile_base_url_invalid",
        "Provider profile base URL must use HTTP or HTTPS.",
      );
    }
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
      return reject(
        "provider_profile_base_url_invalid",
        "Provider profile base URL must use HTTPS unless it targets localhost.",
      );
    }
    return { ok: true, url };
  } catch {
    return reject(
      "provider_profile_base_url_invalid",
      "Provider profile base URL is invalid.",
    );
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return true;
  }

  const parts = normalized.split(".");
  if (parts.length !== 4 || parts.some((part) => part.length === 0)) {
    return false;
  }

  const numbers = parts.map((part) => Number(part));
  return numbers.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    numbers[0] === 127;
}

function isCredentialStatus(
  value: unknown,
): value is HelarcProviderCredentialStatus {
  return value === "present" || value === "empty_allowed" || value === "missing";
}

function reject(
  code: HelarcProviderProfileErrorCode,
  message: string,
): { ok: false; error: HelarcProviderProfileError } {
  return { ok: false, error: { code, message } };
}
export type HelarcProviderService = "generic" | "deepseek" | "ollama";

export interface HelarcProviderModelSettings {
  readonly service: HelarcProviderService;
  readonly thinking: ModelThinkingSelection;
  readonly maximumOutputTokens: number;
}

export function snapshotHelarcProviderModelSettings(
  value: HelarcProviderModelSettings | undefined, kind: HelarcProviderKind,
): HelarcProviderModelSettings {
  const settings = value ?? { service: kind === "ollama" ? "ollama" : "generic", thinking: { mode: "default" }, maximumOutputTokens: 4096 };
  if (!["generic", "deepseek", "ollama"].includes(settings.service) ||
      (settings.service === "ollama") !== (kind === "ollama") ||
      !Number.isSafeInteger(settings.maximumOutputTokens) || settings.maximumOutputTokens <= 0 ||
      Object.keys(settings).some(key => !["service", "thinking", "maximumOutputTokens"].includes(key))) {
    throw new TypeError("Provider model settings are invalid.");
  }
  const thinking = snapshotModelThinkingSelection(settings.thinking);
  if (settings.service === "generic" && thinking.mode !== "default") throw new TypeError("This service has no implemented thinking controls.");
  return Object.freeze({ ...settings, thinking });
}
