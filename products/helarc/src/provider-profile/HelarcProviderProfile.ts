export type HelarcProviderCredentialStatus =
  | "present"
  | "empty_allowed"
  | "missing";

export interface CreateHelarcProviderProfileInput {
  id: string;
  displayName: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  credentialStatus: HelarcProviderCredentialStatus;
  isActive?: boolean;
}

export interface HelarcProviderProfile {
  id: string;
  displayName: string;
  endpointLabel: string;
  baseUrl: string;
  baseUrlOrigin: string;
  model: string;
  timeoutMs: number;
  credentialStatus: HelarcProviderCredentialStatus;
  isActive: boolean;
}

export type HelarcProviderProfileErrorCode =
  | "provider_profile_id_required"
  | "provider_profile_display_name_required"
  | "provider_profile_base_url_required"
  | "provider_profile_base_url_invalid"
  | "provider_profile_model_required"
  | "provider_profile_timeout_invalid"
  | "provider_profile_credential_status_invalid"
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
  if (model.length === 0) {
    return reject("provider_profile_model_required", "Provider profile model is required.");
  }

  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    return reject(
      "provider_profile_timeout_invalid",
      "Provider profile timeout must be a positive number.",
    );
  }

  if (!isCredentialStatus(input.credentialStatus)) {
    return reject(
      "provider_profile_credential_status_invalid",
      "Provider profile credential status is invalid.",
    );
  }

  return {
    ok: true,
    profile: {
      id,
      displayName,
      endpointLabel: urlResult.url.host,
      baseUrl: urlResult.url.toString(),
      baseUrlOrigin: urlResult.url.origin,
      model,
      timeoutMs: input.timeoutMs,
      credentialStatus: input.credentialStatus,
      isActive: input.isActive ?? false,
    },
  };
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
