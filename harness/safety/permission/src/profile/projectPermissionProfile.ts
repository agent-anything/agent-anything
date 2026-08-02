import type {
  ControllerPermissionProfileProjection,
  PermissionProfileSafeProjection,
  ResolvedPermissionProfile,
} from "./PermissionProfile.js";

export function projectPermissionProfile(
  profile: ResolvedPermissionProfile,
): PermissionProfileSafeProjection {
  const accesses = new Set(profile.fileSystem.entries.map((entry) => entry.access));

  return Object.freeze({
    profileId: profile.id,
    sourceProfileIds: Object.freeze([...profile.sourceProfileIds]),
    environmentId: profile.environmentId,
    enforcement: profile.enforcement,
    workspaceRootCount: profile.workspaceRoots.length,
    fileSystem: Object.freeze({
      unrestricted: profile.fileSystem.unrestricted,
      allowsRead:
        profile.fileSystem.unrestricted || accesses.has("read") || accesses.has("write"),
      allowsWrite: profile.fileSystem.unrestricted || accesses.has("write"),
      hasDenials:
        accesses.has("deny") ||
        profile.fileSystem.managedCeilings.some(
          (ceiling) => ceiling.maximumAccess === "none",
        ),
      managed: profile.fileSystem.managedCeilings.length > 0,
    }),
    process: Object.freeze({
      unrestricted: profile.process.unrestricted,
    }),
    network: Object.freeze({
      enabled: profile.network.enabled,
      profileRestricted: profile.network.profileAllowedDomains.length > 0,
      managedRestricted: profile.network.managedAllowedDomains.length > 0,
      hasDenials: profile.network.deniedDomains.length > 0,
    }),
    managedConstraintSetId: profile.managedConstraintSetId,
  });
}

export function projectControllerPermissionProfile(
  profile: ResolvedPermissionProfile,
  canRequestAdditionalPermissions: boolean,
): ControllerPermissionProfileProjection {
  return Object.freeze({
    ...projectPermissionProfile(profile),
    canRequestAdditionalPermissions,
  });
}
