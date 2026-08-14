export type HelarcWorkspaceTrustState = "trusted";

export interface CreateHelarcWorkspaceProfileInput {
  id: string;
  displayName: string;
  path: string;
  lastOpenedAt: string;
  trustState: HelarcWorkspaceTrustState;
}

export interface HelarcWorkspaceProfile {
  id: string;
  displayName: string;
  path: string;
  lastOpenedAt: string;
  trustState: HelarcWorkspaceTrustState;
}

export type HelarcWorkspaceProfileErrorCode =
  | "workspace_profile_id_required"
  | "workspace_profile_display_name_required"
  | "workspace_profile_path_required"
  | "workspace_profile_last_opened_at_invalid"
  | "workspace_profile_trust_state_invalid"
  | "workspace_profile_not_found";

export interface HelarcWorkspaceProfileError {
  code: HelarcWorkspaceProfileErrorCode;
  message: string;
}

export type CreateHelarcWorkspaceProfileResult =
  | { ok: true; profile: HelarcWorkspaceProfile }
  | { ok: false; error: HelarcWorkspaceProfileError };

export type SelectHelarcWorkspaceProfileResult =
  | { ok: true; profile: HelarcWorkspaceProfile }
  | { ok: false; error: HelarcWorkspaceProfileError };

export function createHelarcWorkspaceProfile(
  input: CreateHelarcWorkspaceProfileInput,
): CreateHelarcWorkspaceProfileResult {
  const id = input.id.trim();
  if (id.length === 0) {
    return reject("workspace_profile_id_required", "Workspace profile id is required.");
  }

  const displayName = input.displayName.trim();
  if (displayName.length === 0) {
    return reject(
      "workspace_profile_display_name_required",
      "Workspace profile display name is required.",
    );
  }

  const path = input.path.trim();
  if (path.length === 0) {
    return reject("workspace_profile_path_required", "Workspace profile path is required.");
  }

  if (!isIsoDateTime(input.lastOpenedAt)) {
    return reject(
      "workspace_profile_last_opened_at_invalid",
      "Workspace profile last opened timestamp is invalid.",
    );
  }

  if (input.trustState !== "trusted") {
    return reject(
      "workspace_profile_trust_state_invalid",
      "Workspace profile trust state is invalid.",
    );
  }

  return {
    ok: true,
    profile: {
      id,
      displayName,
      path,
      lastOpenedAt: input.lastOpenedAt,
      trustState: input.trustState,
    },
  };
}

export function selectHelarcWorkspaceProfile(
  profiles: readonly HelarcWorkspaceProfile[],
  profileId: string,
): SelectHelarcWorkspaceProfileResult {
  const id = profileId.trim();
  const profile = profiles.find((item) => item.id === id);
  if (!profile) {
    return reject("workspace_profile_not_found", "Workspace profile was not found.");
  }

  return { ok: true, profile };
}

function isIsoDateTime(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function reject(
  code: HelarcWorkspaceProfileErrorCode,
  message: string,
): { ok: false; error: HelarcWorkspaceProfileError } {
  return { ok: false, error: { code, message } };
}
