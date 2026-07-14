export type ManagedFileSystemTarget =
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

export type ManagedFileSystemMaximumAccess = "read" | "none";

export interface ManagedFileSystemConstraint {
  readonly target: ManagedFileSystemTarget;
  readonly maximumAccess: ManagedFileSystemMaximumAccess;
}

export interface ManagedProfileSelectionConstraints {
  readonly allowedProfileIds: readonly string[] | null;
  readonly deniedProfileIds: readonly string[];
}

export interface ManagedNetworkPermissionConstraints {
  /** Null means that managed configuration adds no network enablement restriction. */
  readonly enabled: boolean | null;
  readonly allowedDomains: readonly string[];
  readonly deniedDomains: readonly string[];
}

export interface ManagedPermissionConstraints {
  readonly constraintSetId: string;
  readonly selectableProfiles: ManagedProfileSelectionConstraints;
  readonly fileSystem: readonly ManagedFileSystemConstraint[];
  readonly network: ManagedNetworkPermissionConstraints;
  readonly allowUnenforcedExecution: boolean;
}
