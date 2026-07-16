import type { ManagedFileSystemMaximumAccess } from "@agent-anything/governance/managed-permission";
import type { Metadata } from "@agent-anything/shared";

export const BUILT_IN_PERMISSION_PROFILE_IDS = [
  ":read-only",
  ":workspace",
  ":danger-full-access",
] as const;

export type BuiltInPermissionProfileId =
  (typeof BUILT_IN_PERMISSION_PROFILE_IDS)[number];

export type PermissionEnvironmentPlatform = "win32" | "posix";
export type PermissionEnforcement = "managed" | "external" | "disabled";
export type FileSystemPermissionAccess = "read" | "write" | "deny";

export interface PermissionWorkspaceRootInput {
  readonly rootId: string;
  readonly path: string;
}

export interface ResolvedPermissionWorkspaceRoot {
  readonly rootId: string;
  readonly canonicalPath: string;
}

export type PermissionFileSystemTarget =
  | {
      readonly kind: "workspace_path";
      readonly rootId: string;
      readonly path: string;
    }
  | {
      readonly kind: "absolute_path";
      readonly path: string;
    }
  | {
      readonly kind: "workspace_glob";
      readonly rootId: string;
      readonly pattern: string;
    }
  | {
      readonly kind: "absolute_glob";
      readonly pattern: string;
    };

export type ResolvedPermissionFileSystemTarget =
  | {
      readonly kind: "absolute_path";
      readonly path: string;
    }
  | {
      readonly kind: "canonical_glob";
      readonly pattern: string;
    };

export interface FileSystemPermissionEntry {
  readonly target: PermissionFileSystemTarget;
  readonly access: FileSystemPermissionAccess;
}

export interface NetworkPermissionPolicy {
  readonly enabled: boolean;
  readonly allowedDomains: readonly string[];
  readonly deniedDomains: readonly string[];
}

export interface PermissionProfileDefinition {
  readonly id: string;
  readonly extends: string | null;
  readonly enforcement: PermissionEnforcement;
  readonly unrestrictedFileSystem: boolean;
  readonly fileSystem: readonly FileSystemPermissionEntry[];
  readonly process: {
    readonly unrestricted: boolean;
  };
  readonly network: NetworkPermissionPolicy;
  readonly metadata: Metadata;
}

export interface PermissionResolutionEnvironmentInput {
  readonly environmentId: string;
  readonly platform: PermissionEnvironmentPlatform;
  readonly workspaceRoots: readonly PermissionWorkspaceRootInput[];
}

export interface ResolvedFileSystemPermissionEntry {
  readonly target: ResolvedPermissionFileSystemTarget;
  readonly access: FileSystemPermissionAccess;
  readonly sourceProfileId: string;
  readonly specificity: number;
}

export interface ResolvedManagedFileSystemCeiling {
  readonly target: ResolvedPermissionFileSystemTarget;
  readonly maximumAccess: ManagedFileSystemMaximumAccess;
  readonly sourceConstraintSetId: string;
  readonly specificity: number;
}

export interface ResolvedFileSystemPermissionPolicy {
  readonly unrestricted: boolean;
  readonly entries: readonly ResolvedFileSystemPermissionEntry[];
  readonly managedCeilings: readonly ResolvedManagedFileSystemCeiling[];
}

export interface ResolvedNetworkPermissionPolicy {
  readonly enabled: boolean;
  readonly profileAllowedDomains: readonly string[];
  readonly managedAllowedDomains: readonly string[];
  readonly deniedDomains: readonly string[];
}

export interface ResolvedPermissionProfile {
  readonly id: string;
  readonly sourceProfileIds: readonly string[];
  readonly environmentId: string;
  readonly platform: PermissionEnvironmentPlatform;
  readonly workspaceRoots: readonly ResolvedPermissionWorkspaceRoot[];
  readonly enforcement: PermissionEnforcement;
  readonly fileSystem: ResolvedFileSystemPermissionPolicy;
  readonly process: {
    readonly unrestricted: boolean;
  };
  readonly network: ResolvedNetworkPermissionPolicy;
  readonly managedConstraintSetId: string;
  readonly metadata: Readonly<Metadata>;
}

export interface PermissionProfileSafeProjection {
  readonly profileId: string;
  readonly sourceProfileIds: readonly string[];
  readonly environmentId: string;
  readonly enforcement: PermissionEnforcement;
  readonly workspaceRootCount: number;
  readonly fileSystem: {
    readonly unrestricted: boolean;
    readonly allowsRead: boolean;
    readonly allowsWrite: boolean;
    readonly hasDenials: boolean;
    readonly managed: boolean;
  };
  readonly process: {
    readonly unrestricted: boolean;
  };
  readonly network: {
    readonly enabled: boolean;
    readonly profileRestricted: boolean;
    readonly managedRestricted: boolean;
    readonly hasDenials: boolean;
  };
  readonly managedConstraintSetId: string;
}

export interface ControllerPermissionProfileProjection
  extends PermissionProfileSafeProjection {
  readonly canRequestAdditionalPermissions: boolean;
}
