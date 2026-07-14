import type { ManagedPermissionConstraints } from "@agent-anything/governance/managed-permission";
import type { Metadata } from "@agent-anything/shared";
import {
  canonicalizePermissionDomains,
  canonicalizePermissionFileSystemTarget,
  resolvePermissionWorkspaceRoots,
  type CanonicalPermissionWorkspaceRoot,
} from "./PermissionCanonicalization.js";
import {
  BUILT_IN_PERMISSION_PROFILE_IDS,
  type FileSystemPermissionAccess,
  type PermissionProfileDefinition,
  type PermissionResolutionEnvironmentInput,
  type ResolvedFileSystemPermissionEntry,
  type ResolvedManagedFileSystemCeiling,
  type ResolvedPermissionFileSystemTarget,
  type ResolvedPermissionProfile,
} from "./PermissionProfile.js";
import { PermissionProfileResolutionError } from "./PermissionProfileResolutionError.js";

export interface ResolvePermissionProfileInput {
  readonly profileId: string;
  readonly profiles: readonly PermissionProfileDefinition[];
  readonly environment: PermissionResolutionEnvironmentInput;
  readonly managedConstraints: ManagedPermissionConstraints;
}

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ACCESS_PRECEDENCE: Readonly<Record<FileSystemPermissionAccess, number>> = {
  deny: 3,
  write: 2,
  read: 1,
};

export function resolvePermissionProfile(
  input: ResolvePermissionProfileInput,
): ResolvedPermissionProfile {
  validateEnvironmentId(input.environment.environmentId);
  const roots = resolvePermissionWorkspaceRoots(input.environment);
  const constraints = input.managedConstraints;
  validateManagedConstraintIdentity(constraints.constraintSetId);
  validateProfileSelection(input.profileId, constraints);

  const definitions = createProfileRegistry(input.profiles, roots);
  const chain = resolveInheritanceChain(input.profileId, definitions);
  const selected = chain.at(-1);
  if (!selected) {
    throw new PermissionProfileResolutionError(
      "unknown_base_profile",
      `Permission profile '${input.profileId}' is not registered.`,
    );
  }

  if (selected.enforcement === "disabled" && !constraints.allowUnenforcedExecution) {
    throw new PermissionProfileResolutionError(
      "unenforced_execution_forbidden",
      `Managed constraint set '${constraints.constraintSetId}' forbids disabled enforcement.`,
    );
  }

  const profileEntries = chain.flatMap((definition) =>
    definition.fileSystem.map((entry) => ({
      target: canonicalizePermissionFileSystemTarget(
        entry.target,
        roots,
        input.environment.platform,
      ),
      access: entry.access,
      sourceProfileId: definition.id,
    })),
  );
  const resolvedEntries = sortProfileEntries(profileEntries);
  const managedCeilings = sortManagedCeilings(
    constraints.fileSystem.map((constraint) => ({
      target: canonicalizePermissionFileSystemTarget(
        constraint.target,
        roots,
        input.environment.platform,
      ),
      maximumAccess: constraint.maximumAccess,
      sourceConstraintSetId: constraints.constraintSetId,
    })),
  );

  const profileAllowedDomains = canonicalizePermissionDomains(
    chain.flatMap((definition) => definition.network.allowedDomains),
  );
  const managedAllowedDomains = canonicalizePermissionDomains(
    constraints.network.allowedDomains,
  );
  const deniedDomains = canonicalizePermissionDomains([
    ...chain.flatMap((definition) => definition.network.deniedDomains),
    ...constraints.network.deniedDomains,
  ]);
  const profileNetworkEnabled = chain.some(
    (definition) => definition.network.enabled,
  );
  const unrestricted = chain.some(
    (definition) => definition.unrestrictedFileSystem,
  );

  const profile: ResolvedPermissionProfile = {
    id: selected.id,
    sourceProfileIds: chain.map((definition) => definition.id),
    environmentId: input.environment.environmentId,
    platform: input.environment.platform,
    workspaceRoots: roots.map(({ rootId, canonicalPath }) => ({
      rootId,
      canonicalPath,
    })),
    enforcement: selected.enforcement,
    fileSystem: {
      unrestricted,
      entries: resolvedEntries,
      managedCeilings,
    },
    network: {
      enabled:
        profileNetworkEnabled && constraints.network.enabled !== false,
      profileAllowedDomains,
      managedAllowedDomains,
      deniedDomains,
    },
    managedConstraintSetId: constraints.constraintSetId,
    metadata: mergeMetadata(chain),
  };

  return deepFreeze(profile);
}

function createProfileRegistry(
  customProfiles: readonly PermissionProfileDefinition[],
  roots: readonly CanonicalPermissionWorkspaceRoot[],
): ReadonlyMap<string, PermissionProfileDefinition> {
  const registry = new Map<string, PermissionProfileDefinition>();
  for (const definition of createBuiltInProfiles(roots)) {
    registry.set(definition.id, definition);
  }

  for (const definition of [...customProfiles]) {
    validateCustomProfileDefinition(definition);
    if (BUILT_IN_PERMISSION_PROFILE_IDS.includes(
      definition.id as (typeof BUILT_IN_PERMISSION_PROFILE_IDS)[number],
    )) {
      throw new PermissionProfileResolutionError(
        "reserved_profile_id",
        `Permission profile id '${definition.id}' is reserved.`,
      );
    }
    if (registry.has(definition.id)) {
      throw new PermissionProfileResolutionError(
        "duplicate_profile_id",
        `Permission profile id '${definition.id}' is duplicated.`,
      );
    }
    registry.set(definition.id, cloneProfileDefinition(definition));
  }

  return registry;
}

function createBuiltInProfiles(
  roots: readonly CanonicalPermissionWorkspaceRoot[],
): readonly PermissionProfileDefinition[] {
  const readEntries = roots.map(({ rootId }) => ({
    target: { kind: "workspace_path", rootId, path: "." } as const,
    access: "read" as const,
  }));
  const writeEntries = roots.map(({ rootId }) => ({
    target: { kind: "workspace_path", rootId, path: "." } as const,
    access: "write" as const,
  }));

  return [
    {
      id: ":read-only",
      extends: null,
      enforcement: "managed",
      unrestrictedFileSystem: false,
      fileSystem: readEntries,
      network: { enabled: false, allowedDomains: [], deniedDomains: [] },
      metadata: {},
    },
    {
      id: ":workspace",
      extends: ":read-only",
      enforcement: "managed",
      unrestrictedFileSystem: false,
      fileSystem: writeEntries,
      network: { enabled: false, allowedDomains: [], deniedDomains: [] },
      metadata: {},
    },
    {
      id: ":danger-full-access",
      extends: null,
      enforcement: "disabled",
      unrestrictedFileSystem: true,
      fileSystem: [],
      network: { enabled: true, allowedDomains: [], deniedDomains: [] },
      metadata: {},
    },
  ];
}

function validateCustomProfileDefinition(
  definition: PermissionProfileDefinition,
): void {
  if (!PROFILE_ID_PATTERN.test(definition.id)) {
    throw new PermissionProfileResolutionError(
      "invalid_profile_id",
      `Custom permission profile id '${definition.id}' is invalid.`,
    );
  }
  if (definition.extends !== null && !isValidProfileReference(definition.extends)) {
    throw new PermissionProfileResolutionError(
      "invalid_profile_id",
      `Base permission profile id '${definition.extends}' is invalid.`,
    );
  }
  if (
    definition.enforcement !== "managed" &&
    definition.enforcement !== "external" &&
    definition.enforcement !== "disabled"
  ) {
    throw new PermissionProfileResolutionError(
      "invalid_profile_definition",
      `Permission profile '${definition.id}' has invalid enforcement.`,
    );
  }
  if (typeof definition.unrestrictedFileSystem !== "boolean") {
    throw new PermissionProfileResolutionError(
      "invalid_profile_definition",
      `Permission profile '${definition.id}' has invalid unrestricted filesystem state.`,
    );
  }
  for (const entry of definition.fileSystem) {
    if (entry.access !== "read" && entry.access !== "write" && entry.access !== "deny") {
      throw new PermissionProfileResolutionError(
        "invalid_profile_definition",
        `Permission profile '${definition.id}' has invalid filesystem access.`,
      );
    }
  }
  if (typeof definition.network.enabled !== "boolean") {
    throw new PermissionProfileResolutionError(
      "invalid_profile_definition",
      `Permission profile '${definition.id}' has invalid network enablement.`,
    );
  }
}

function cloneProfileDefinition(
  definition: PermissionProfileDefinition,
): PermissionProfileDefinition {
  return {
    id: definition.id,
    extends: definition.extends,
    enforcement: definition.enforcement,
    unrestrictedFileSystem: definition.unrestrictedFileSystem,
    fileSystem: definition.fileSystem.map((entry) => ({
      target: { ...entry.target },
      access: entry.access,
    })),
    network: {
      enabled: definition.network.enabled,
      allowedDomains: [...definition.network.allowedDomains],
      deniedDomains: [...definition.network.deniedDomains],
    },
    metadata: cloneMetadata(definition.metadata),
  };
}

function resolveInheritanceChain(
  profileId: string,
  registry: ReadonlyMap<string, PermissionProfileDefinition>,
): readonly PermissionProfileDefinition[] {
  if (!isValidProfileReference(profileId)) {
    throw new PermissionProfileResolutionError(
      "invalid_profile_id",
      `Permission profile id '${profileId}' is invalid.`,
    );
  }

  const chain: PermissionProfileDefinition[] = [];
  const visiting: string[] = [];
  const visited = new Set<string>();

  const visit = (id: string): void => {
    const definition = registry.get(id);
    if (!definition) {
      throw new PermissionProfileResolutionError(
        "unknown_base_profile",
        `Permission profile '${id}' is not registered.`,
      );
    }
    const cycleStart = visiting.indexOf(id);
    if (cycleStart >= 0) {
      const cycle = [...visiting.slice(cycleStart), id].join(" -> ");
      throw new PermissionProfileResolutionError(
        "inheritance_cycle",
        `Permission profile inheritance cycle detected: ${cycle}.`,
      );
    }
    if (visited.has(id)) {
      return;
    }

    visiting.push(id);
    if (definition.extends !== null) {
      visit(definition.extends);
    }
    visiting.pop();
    visited.add(id);
    chain.push(definition);
  };

  visit(profileId);
  return chain;
}

function validateProfileSelection(
  profileId: string,
  constraints: ManagedPermissionConstraints,
): void {
  if (typeof constraints.allowUnenforcedExecution !== "boolean") {
    throw new PermissionProfileResolutionError(
      "invalid_managed_constraint",
      `Managed constraint set '${constraints.constraintSetId}' has invalid enforcement configuration.`,
    );
  }
  for (const constraint of constraints.fileSystem) {
    if (
      constraint.maximumAccess !== "read" &&
      constraint.maximumAccess !== "none"
    ) {
      throw new PermissionProfileResolutionError(
        "invalid_managed_constraint",
        `Managed constraint set '${constraints.constraintSetId}' has invalid filesystem maximum access.`,
      );
    }
  }

  const denied = new Set(constraints.selectableProfiles.deniedProfileIds);
  if (denied.has(profileId)) {
    throw new PermissionProfileResolutionError(
      "profile_denied",
      `Managed constraint set '${constraints.constraintSetId}' denies profile '${profileId}'.`,
    );
  }

  const allowed = constraints.selectableProfiles.allowedProfileIds;
  if (allowed !== null && !allowed.includes(profileId)) {
    throw new PermissionProfileResolutionError(
      "profile_not_allowed",
      `Managed constraint set '${constraints.constraintSetId}' does not allow profile '${profileId}'.`,
    );
  }

  for (const id of [
    ...(allowed ?? []),
    ...constraints.selectableProfiles.deniedProfileIds,
  ]) {
    if (!isValidProfileReference(id)) {
      throw new PermissionProfileResolutionError(
        "invalid_managed_constraint",
        `Managed profile selection id '${id}' is invalid.`,
      );
    }
  }
  if (
    constraints.network.enabled !== null &&
    typeof constraints.network.enabled !== "boolean"
  ) {
    throw new PermissionProfileResolutionError(
      "invalid_managed_constraint",
      `Managed constraint set '${constraints.constraintSetId}' has invalid network enablement.`,
    );
  }
}

function sortProfileEntries(
  entries: readonly Omit<ResolvedFileSystemPermissionEntry, "specificity">[],
): readonly ResolvedFileSystemPermissionEntry[] {
  return entries
    .map((entry) => ({ ...entry, specificity: targetSpecificity(entry.target) }))
    .sort((left, right) =>
      right.specificity - left.specificity ||
      ACCESS_PRECEDENCE[right.access] - ACCESS_PRECEDENCE[left.access] ||
      targetValue(left.target).localeCompare(targetValue(right.target)) ||
      left.sourceProfileId.localeCompare(right.sourceProfileId),
    );
}

function sortManagedCeilings(
  ceilings: readonly Omit<ResolvedManagedFileSystemCeiling, "specificity">[],
): readonly ResolvedManagedFileSystemCeiling[] {
  return ceilings
    .map((ceiling) => ({
      ...ceiling,
      specificity: targetSpecificity(ceiling.target),
    }))
    .sort((left, right) =>
      right.specificity - left.specificity ||
      maximumAccessPrecedence(right.maximumAccess) -
        maximumAccessPrecedence(left.maximumAccess) ||
      targetValue(left.target).localeCompare(targetValue(right.target)),
    );
}

function targetSpecificity(target: ResolvedPermissionFileSystemTarget): number {
  const value = targetValue(target);
  if (target.kind === "absolute_path") {
    return 1_000_000 + value.length;
  }
  return value.replace(/[*?[\]{}]/g, "").length;
}

function targetValue(target: ResolvedPermissionFileSystemTarget): string {
  return target.kind === "absolute_path" ? target.path : target.pattern;
}

function maximumAccessPrecedence(value: "read" | "none"): number {
  return value === "none" ? 2 : 1;
}

function mergeMetadata(
  chain: readonly PermissionProfileDefinition[],
): Readonly<Metadata> {
  const result: Metadata = {};
  for (const definition of chain) {
    Object.assign(result, cloneMetadata(definition.metadata));
  }
  return result;
}

function cloneMetadata(metadata: Metadata): Metadata {
  const clone = cloneMetadataValue(metadata, "metadata");
  if (!isPlainRecord(clone)) {
    throw new PermissionProfileResolutionError(
      "invalid_metadata",
      "Permission profile metadata must be a plain object.",
    );
  }
  return clone;
}

function cloneMetadataValue(value: unknown, path: string): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneMetadataValue(item, `${path}[${index}]`));
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        cloneMetadataValue(item, `${path}.${key}`),
      ]),
    );
  }
  throw new PermissionProfileResolutionError(
    "invalid_metadata",
    `Permission profile ${path} contains a non-snapshot value.`,
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function validateEnvironmentId(environmentId: string): void {
  if (!IDENTITY_PATTERN.test(environmentId)) {
    throw new PermissionProfileResolutionError(
      "invalid_environment",
      `Permission environment id '${environmentId}' is invalid.`,
    );
  }
}

function validateManagedConstraintIdentity(constraintSetId: string): void {
  if (!IDENTITY_PATTERN.test(constraintSetId)) {
    throw new PermissionProfileResolutionError(
      "invalid_managed_constraint",
      `Managed constraint set id '${constraintSetId}' is invalid.`,
    );
  }
}

function isValidProfileReference(id: string): boolean {
  return (
    BUILT_IN_PERMISSION_PROFILE_IDS.includes(
      id as (typeof BUILT_IN_PERMISSION_PROFILE_IDS)[number],
    ) || PROFILE_ID_PATTERN.test(id)
  );
}
