import type { ManagedPermissionConstraints } from "@agent-anything/governance/managed-permission";
import {
  canonicalizePermissionDomains,
  canonicalizePermissionFileSystemTarget,
  canonicalizePermissionPathFromCwd,
  matchesPermissionDomainPattern,
  matchesPermissionFileSystemTarget,
  resolvePermissionWorkspaceRoots,
} from "../profile/PermissionCanonicalization.js";
import type {
  PermissionEnvironmentPlatform,
  PermissionResolutionEnvironmentInput,
} from "../profile/PermissionProfile.js";
import { PermissionProfileResolutionError } from "../profile/PermissionProfileResolutionError.js";

export interface AdditionalPermissions {
  readonly fileSystem?: {
    readonly read?: readonly string[];
    readonly write?: readonly string[];
  };
  readonly network?: {
    readonly enabled: boolean;
    readonly domains?: readonly string[];
  };
}

export interface CanonicalAdditionalPermissions {
  readonly fileSystem?: {
    readonly read?: readonly string[];
    readonly write?: readonly string[];
  };
  readonly network?: {
    readonly enabled: true;
    readonly domains?: readonly string[];
  };
}

declare const grantedPermissionsBrand: unique symbol;

export interface GrantedPermissions extends CanonicalAdditionalPermissions {
  readonly [grantedPermissionsBrand]: true;
}

export type PermissionDeltaValidationCode =
  | "permissions_empty"
  | "permissions_invalid_path"
  | "permissions_invalid_domain"
  | "permissions_network_not_enabled"
  | "permissions_read_not_requested"
  | "permissions_write_not_requested"
  | "permissions_domain_not_requested"
  | "permissions_managed_filesystem_denied"
  | "permissions_managed_network_denied";

export interface PermissionDeltaInvalidResult {
  readonly status: "invalid";
  readonly code: PermissionDeltaValidationCode;
  readonly message: string;
}

export type CanonicalizeAdditionalPermissionsResult =
  | { readonly status: "valid"; readonly permissions: CanonicalAdditionalPermissions }
  | PermissionDeltaInvalidResult;

export type ValidateGrantedPermissionsResult =
  | { readonly status: "valid"; readonly permissions: GrantedPermissions }
  | PermissionDeltaInvalidResult;

export interface CanonicalizeAdditionalPermissionsInput {
  readonly permissions: AdditionalPermissions;
  readonly cwd: string;
  readonly environment: PermissionResolutionEnvironmentInput;
}

export interface ValidateGrantedPermissionsInput {
  readonly requested: CanonicalAdditionalPermissions;
  readonly granted: AdditionalPermissions;
  readonly cwd: string;
  readonly environment: PermissionResolutionEnvironmentInput;
  readonly managedConstraints: ManagedPermissionConstraints;
}

export function canonicalizeAdditionalPermissions(
  input: CanonicalizeAdditionalPermissionsInput,
): CanonicalizeAdditionalPermissionsResult {
  try {
    const read = canonicalizePaths(input.permissions.fileSystem?.read ?? [], input);
    const write = canonicalizePaths(input.permissions.fileSystem?.write ?? [], input);
    const network = input.permissions.network;
    const domains = network?.enabled
      ? canonicalizePermissionDomains(network.domains ?? [])
      : [];

    if (read.length === 0 && write.length === 0 && !network?.enabled) {
      return invalid("permissions_empty", "Permission delta contains no authority.");
    }

    const permissions: CanonicalAdditionalPermissions = {
      ...(read.length > 0 || write.length > 0
        ? {
            fileSystem: {
              ...(read.length > 0 ? { read } : {}),
              ...(write.length > 0 ? { write } : {}),
            },
          }
        : {}),
      ...(network?.enabled
        ? {
            network: {
              enabled: true as const,
              ...(domains.length > 0 ? { domains } : {}),
            },
          }
        : {}),
    };
    return Object.freeze({ status: "valid", permissions: deepFreeze(permissions) });
  } catch (error) {
    if (error instanceof PermissionProfileResolutionError) {
      return invalid(
        error.code === "invalid_domain"
          ? "permissions_invalid_domain"
          : "permissions_invalid_path",
        error.message,
      );
    }
    throw error;
  }
}

export function validateGrantedPermissions(
  input: ValidateGrantedPermissionsInput,
): ValidateGrantedPermissionsResult {
  const canonical = canonicalizeAdditionalPermissions({
    permissions: input.granted,
    cwd: input.cwd,
    environment: input.environment,
  });
  if (canonical.status === "invalid") return canonical;

  const subsetFailure = validateRequestedSubset(
    input.requested,
    canonical.permissions,
    input.environment.platform,
  );
  if (subsetFailure) return subsetFailure;

  const managedFailure = validateManagedConstraints(
    canonical.permissions,
    input.environment,
    input.managedConstraints,
  );
  if (managedFailure) return managedFailure;

  return Object.freeze({
    status: "valid",
    permissions: canonical.permissions as GrantedPermissions,
  });
}

function validateRequestedSubset(
  requested: CanonicalAdditionalPermissions,
  granted: CanonicalAdditionalPermissions,
  platform: PermissionEnvironmentPlatform,
): PermissionDeltaInvalidResult | null {
  const requestedRead = requested.fileSystem?.read ?? [];
  const requestedWrite = requested.fileSystem?.write ?? [];
  for (const path of granted.fileSystem?.read ?? []) {
    if (
      !isPathCovered(path, requestedRead, platform) &&
      !isPathCovered(path, requestedWrite, platform)
    ) {
      return invalid(
        "permissions_read_not_requested",
        `Read permission '${path}' is outside the requested authority.`,
      );
    }
  }
  for (const path of granted.fileSystem?.write ?? []) {
    if (!isPathCovered(path, requestedWrite, platform)) {
      return invalid(
        "permissions_write_not_requested",
        `Write permission '${path}' is outside the requested authority.`,
      );
    }
  }

  if (granted.network) {
    if (!requested.network?.enabled) {
      return invalid(
        "permissions_network_not_enabled",
        "Network authority was not requested.",
      );
    }
    const requestedDomains = requested.network.domains ?? [];
    const grantedDomains = granted.network.domains ?? [];
    if (requestedDomains.length > 0 && grantedDomains.length === 0) {
      return invalid(
        "permissions_domain_not_requested",
        "Unrestricted network authority exceeds the requested domain set.",
      );
    }
    for (const domain of grantedDomains) {
      if (
        requestedDomains.length > 0 &&
        !requestedDomains.some((pattern) => isDomainPatternSubset(domain, pattern))
      ) {
        return invalid(
          "permissions_domain_not_requested",
          `Network domain '${domain}' is outside the requested authority.`,
        );
      }
    }
  }
  return null;
}

function validateManagedConstraints(
  granted: CanonicalAdditionalPermissions,
  environment: PermissionResolutionEnvironmentInput,
  constraints: ManagedPermissionConstraints,
): PermissionDeltaInvalidResult | null {
  const roots = resolvePermissionWorkspaceRoots(environment);
  const ceilings = constraints.fileSystem.map((constraint) => ({
    maximumAccess: constraint.maximumAccess,
    target: canonicalizePermissionFileSystemTarget(
      constraint.target,
      roots,
      environment.platform,
    ),
  }));

  for (const path of granted.fileSystem?.read ?? []) {
    if (
      ceilings.some(
        (ceiling) =>
          ceiling.maximumAccess === "none" &&
          matchesPermissionFileSystemTarget(ceiling.target, path, environment.platform),
      )
    ) {
      return invalid(
        "permissions_managed_filesystem_denied",
        `Managed constraints deny read authority for '${path}'.`,
      );
    }
  }
  for (const path of granted.fileSystem?.write ?? []) {
    if (
      ceilings.some((ceiling) =>
        matchesPermissionFileSystemTarget(ceiling.target, path, environment.platform),
      )
    ) {
      return invalid(
        "permissions_managed_filesystem_denied",
        `Managed constraints deny write authority for '${path}'.`,
      );
    }
  }

  if (!granted.network) return null;
  if (constraints.network.enabled === false) {
    return invalid(
      "permissions_managed_network_denied",
      "Managed constraints disable network authority.",
    );
  }
  const managedAllowed = canonicalizePermissionDomains(
    constraints.network.allowedDomains,
  );
  const managedDenied = canonicalizePermissionDomains(
    constraints.network.deniedDomains,
  );
  const grantedDomains = granted.network.domains ?? [];
  if (managedAllowed.length > 0 && grantedDomains.length === 0) {
    return invalid(
      "permissions_managed_network_denied",
      "Managed constraints do not permit unrestricted network authority.",
    );
  }
  for (const domain of grantedDomains) {
    if (
      managedDenied.some((pattern) => patternsOverlap(domain, pattern)) ||
      (managedAllowed.length > 0 &&
        !managedAllowed.some((pattern) => isDomainPatternSubset(domain, pattern)))
    ) {
      return invalid(
        "permissions_managed_network_denied",
        `Managed constraints deny network authority for '${domain}'.`,
      );
    }
  }
  return null;
}

function canonicalizePaths(
  paths: readonly string[],
  input: Pick<CanonicalizeAdditionalPermissionsInput, "cwd" | "environment">,
): readonly string[] {
  const canonical = paths.map((path) =>
    canonicalizePermissionPathFromCwd(path, input.cwd, input.environment.platform),
  );
  return [...new Set(canonical)].sort((left, right) => left.localeCompare(right));
}

function isPathCovered(
  candidate: string,
  requested: readonly string[],
  platform: PermissionEnvironmentPlatform,
): boolean {
  const key = platform === "win32" ? candidate.toLowerCase() : candidate;
  return requested.some((path) => {
    const base = platform === "win32" ? path.toLowerCase() : path;
    const normalizedBase =
      base.length > 1 && base.endsWith("/") ? base.slice(0, -1) : base;
    return key === normalizedBase || key.startsWith(`${normalizedBase}/`);
  });
}

function isDomainPatternSubset(candidate: string, upperBound: string): boolean {
  if (!candidate.startsWith("*.")) {
    return matchesPermissionDomainPattern(upperBound, candidate);
  }
  if (!upperBound.startsWith("*.")) return false;
  const candidateBase = candidate.slice(2);
  const upperBase = upperBound.slice(2);
  return candidateBase === upperBase || candidateBase.endsWith(`.${upperBase}`);
}

function patternsOverlap(left: string, right: string): boolean {
  if (!left.startsWith("*.")) return matchesPermissionDomainPattern(right, left);
  if (!right.startsWith("*.")) return matchesPermissionDomainPattern(left, right);
  const leftBase = left.slice(2);
  const rightBase = right.slice(2);
  return (
    leftBase === rightBase ||
    leftBase.endsWith(`.${rightBase}`) ||
    rightBase.endsWith(`.${leftBase}`)
  );
}

function invalid(
  code: PermissionDeltaValidationCode,
  message: string,
): PermissionDeltaInvalidResult {
  return Object.freeze({ status: "invalid", code, message });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
