import type {
  ManagedFileSystemTarget,
  ManagedPermissionConstraints,
} from "@agent-anything/governance/managed-permission";
import type { Metadata } from "@agent-anything/shared";
import {
  BUILT_IN_PERMISSION_PROFILE_IDS,
  type FileSystemPermissionAccess,
  type PermissionEnvironmentPlatform,
  type PermissionFileSystemTarget,
  type PermissionProfileDefinition,
  type PermissionResolutionEnvironmentInput,
  type ResolvedFileSystemPermissionEntry,
  type ResolvedManagedFileSystemCeiling,
  type ResolvedPermissionFileSystemTarget,
  type ResolvedPermissionProfile,
  type ResolvedPermissionWorkspaceRoot,
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
const GLOB_CHARACTER_PATTERN = /[*?[\]{}]/;
const ACCESS_PRECEDENCE: Readonly<Record<FileSystemPermissionAccess, number>> = {
  deny: 3,
  write: 2,
  read: 1,
};

type CanonicalWorkspaceRoot = ResolvedPermissionWorkspaceRoot;

export function resolvePermissionProfile(
  input: ResolvePermissionProfileInput,
): ResolvedPermissionProfile {
  validateEnvironmentId(input.environment.environmentId);
  const roots = resolveWorkspaceRoots(input.environment);
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
      target: canonicalizeTarget(
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
      target: canonicalizeTarget(
        constraint.target,
        roots,
        input.environment.platform,
      ),
      maximumAccess: constraint.maximumAccess,
      sourceConstraintSetId: constraints.constraintSetId,
    })),
  );

  const profileAllowedDomains = canonicalizeDomains(
    chain.flatMap((definition) => definition.network.allowedDomains),
  );
  const managedAllowedDomains = canonicalizeDomains(
    constraints.network.allowedDomains,
  );
  const deniedDomains = canonicalizeDomains([
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
  roots: readonly CanonicalWorkspaceRoot[],
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
  roots: readonly CanonicalWorkspaceRoot[],
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

function resolveWorkspaceRoots(
  environment: PermissionResolutionEnvironmentInput,
): readonly CanonicalWorkspaceRoot[] {
  if (environment.platform !== "win32" && environment.platform !== "posix") {
    throw new PermissionProfileResolutionError(
      "invalid_environment",
      `Permission environment platform '${String(environment.platform)}' is invalid.`,
    );
  }

  const rootIds = new Set<string>();
  const canonicalPaths = new Set<string>();
  return [...environment.workspaceRoots]
    .map((root) => {
      if (!IDENTITY_PATTERN.test(root.rootId)) {
        throw new PermissionProfileResolutionError(
          "invalid_workspace_root",
          `Workspace root id '${root.rootId}' is invalid.`,
        );
      }
      if (rootIds.has(root.rootId)) {
        throw new PermissionProfileResolutionError(
          "duplicate_workspace_root",
          `Workspace root id '${root.rootId}' is duplicated.`,
        );
      }
      rootIds.add(root.rootId);

      const canonicalPath = canonicalizeAbsolutePath(root.path, environment.platform);
      const comparablePath = compareKey(canonicalPath, environment.platform);
      if (canonicalPaths.has(comparablePath)) {
        throw new PermissionProfileResolutionError(
          "duplicate_workspace_root",
          `Workspace root path '${canonicalPath}' is duplicated.`,
        );
      }
      canonicalPaths.add(comparablePath);
      return {
        rootId: root.rootId,
        canonicalPath,
      };
    })
    .sort((left, right) => left.rootId.localeCompare(right.rootId));
}

function canonicalizeTarget(
  target: PermissionFileSystemTarget | ManagedFileSystemTarget,
  roots: readonly CanonicalWorkspaceRoot[],
  platform: PermissionEnvironmentPlatform,
): ResolvedPermissionFileSystemTarget {
  switch (target.kind) {
    case "absolute_path":
      return {
        kind: "absolute_path",
        path: canonicalizeAbsolutePath(target.path, platform),
      };
    case "workspace_path": {
      const root = findWorkspaceRoot(target.rootId, roots);
      return {
        kind: "absolute_path",
        path: resolveWorkspacePath(target.path, root, platform),
      };
    }
    case "absolute_glob":
      return {
        kind: "canonical_glob",
        pattern: canonicalizeAbsoluteGlob(target.pattern, platform),
      };
    case "workspace_glob": {
      const root = findWorkspaceRoot(target.rootId, roots);
      return {
        kind: "canonical_glob",
        pattern: resolveWorkspaceGlob(target.pattern, root),
      };
    }
    default:
      throw new PermissionProfileResolutionError(
        "invalid_path",
        "Filesystem target kind is invalid.",
      );
  }
}

function findWorkspaceRoot(
  rootId: string,
  roots: readonly CanonicalWorkspaceRoot[],
): CanonicalWorkspaceRoot {
  const root = roots.find((candidate) => candidate.rootId === rootId);
  if (!root) {
    throw new PermissionProfileResolutionError(
      "unknown_workspace_root",
      `Workspace root '${rootId}' is not part of the permission environment.`,
    );
  }
  return root;
}

function resolveWorkspacePath(
  relativePath: string,
  root: CanonicalWorkspaceRoot,
  platform: PermissionEnvironmentPlatform,
): string {
  validatePathText(relativePath);
  if (GLOB_CHARACTER_PATTERN.test(relativePath)) {
    throw new PermissionProfileResolutionError(
      "invalid_path",
      `Workspace path '${relativePath}' contains glob characters.`,
    );
  }
  if (isAbsolutePath(relativePath, platform)) {
    throw new PermissionProfileResolutionError(
      "invalid_path",
      `Workspace path '${relativePath}' must be relative.`,
    );
  }
  const normalized = normalizeRelativePath(relativePath, "path_outside_workspace");
  return normalized.length === 0
    ? root.canonicalPath
    : joinPortable(root.canonicalPath, normalized);
}

function resolveWorkspaceGlob(
  pattern: string,
  root: CanonicalWorkspaceRoot,
): string {
  const relative = canonicalizeRelativeGlob(pattern);
  return joinPortable(root.canonicalPath, relative);
}

function canonicalizeAbsoluteGlob(
  pattern: string,
  platform: PermissionEnvironmentPlatform,
): string {
  validatePathText(pattern);
  const portable = pattern.replace(/\\/g, "/");
  const wildcardIndex = portable.search(GLOB_CHARACTER_PATTERN);
  const prefix = wildcardIndex >= 0 ? portable.slice(0, wildcardIndex) : portable;
  const lastSeparator = prefix.lastIndexOf("/");
  const base = lastSeparator >= 0 ? prefix.slice(0, lastSeparator + 1) : prefix;
  if (base.length === 0) {
    throw new PermissionProfileResolutionError(
      "invalid_glob",
      `Absolute glob '${pattern}' has no absolute base path.`,
    );
  }
  const canonicalBase = canonicalizeAbsolutePath(base, platform);
  const suffix = portable.slice(base.length);
  const canonicalSuffix = canonicalizeRelativeGlob(suffix);
  return joinPortable(canonicalBase, canonicalSuffix);
}

function canonicalizeRelativeGlob(pattern: string): string {
  validatePathText(pattern);
  const portable = pattern.replace(/\\/g, "/");
  if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable)) {
    throw new PermissionProfileResolutionError(
      "invalid_glob",
      `Workspace glob '${pattern}' must be relative.`,
    );
  }
  const segments = portable.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new PermissionProfileResolutionError(
      "path_outside_workspace",
      `Glob '${pattern}' escapes its workspace root.`,
    );
  }
  if (segments.length === 0) {
    throw new PermissionProfileResolutionError(
      "invalid_glob",
      `Glob '${pattern}' is empty.`,
    );
  }
  return segments.join("/");
}

function canonicalizeAbsolutePath(
  value: string,
  platform: PermissionEnvironmentPlatform,
): string {
  validatePathText(value);
  if (GLOB_CHARACTER_PATTERN.test(value)) {
    throw new PermissionProfileResolutionError(
      "invalid_path",
      `Absolute path '${value}' contains glob characters.`,
    );
  }
  const portable = value.replace(/\\/g, "/");
  if (!isAbsolutePath(portable, platform)) {
    throw new PermissionProfileResolutionError(
      "invalid_path",
      `Path '${value}' must be absolute for ${platform}.`,
    );
  }

  const { prefix, remainder } = splitAbsolutePrefix(portable, platform);
  const segments = normalizeSegments(remainder.split("/"), "invalid_path");
  if (segments.length === 0) {
    return prefix.endsWith("/") ? prefix : `${prefix}/`;
  }
  return joinPortable(prefix, segments.join("/"));
}

function canonicalizeDomains(domains: readonly string[]): readonly string[] {
  return [...new Set(domains.map(canonicalizeDomain))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function canonicalizeDomain(value: string): string {
  if (typeof value !== "string") {
    throw new PermissionProfileResolutionError(
      "invalid_domain",
      "Network domain must be a string.",
    );
  }
  let candidate = value.trim().toLowerCase();
  if (
    candidate.length === 0 ||
    candidate.includes("://") ||
    candidate.includes("/") ||
    candidate.includes("@") ||
    /\s/.test(candidate)
  ) {
    throw new PermissionProfileResolutionError(
      "invalid_domain",
      `Network domain '${value}' is invalid.`,
    );
  }
  const wildcard = candidate.startsWith("*.");
  if (wildcard) {
    candidate = candidate.slice(2);
  }
  if (candidate.includes("*") || candidate.includes(":")) {
    throw new PermissionProfileResolutionError(
      "invalid_domain",
      `Network domain '${value}' contains an unsupported wildcard or port.`,
    );
  }
  candidate = candidate.replace(/\.+$/, "");
  let ascii: string;
  try {
    ascii = new URL(`http://${candidate}`).hostname.toLowerCase();
  } catch {
    throw new PermissionProfileResolutionError(
      "invalid_domain",
      `Network domain '${value}' cannot be canonicalized.`,
    );
  }
  if (
    ascii.length === 0 ||
    ascii.split(".").some((label: string) => label.length === 0)
  ) {
    throw new PermissionProfileResolutionError(
      "invalid_domain",
      `Network domain '${value}' cannot be canonicalized.`,
    );
  }
  return wildcard ? `*.${ascii}` : ascii;
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

function validatePathText(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new PermissionProfileResolutionError(
      "invalid_path",
      "Filesystem path must be a non-empty string without null bytes.",
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

function compareKey(
  value: string,
  platform: PermissionEnvironmentPlatform,
): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

function joinPortable(base: string, suffix: string): string {
  return base.endsWith("/") ? `${base}${suffix}` : `${base}/${suffix}`;
}

function isAbsolutePath(
  value: string,
  platform: PermissionEnvironmentPlatform,
): boolean {
  const portable = value.replace(/\\/g, "/");
  if (platform === "posix") {
    return portable.startsWith("/");
  }
  return /^[A-Za-z]:\//.test(portable) || /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(portable);
}

function splitAbsolutePrefix(
  portable: string,
  platform: PermissionEnvironmentPlatform,
): { readonly prefix: string; readonly remainder: string } {
  if (platform === "posix") {
    return { prefix: "/", remainder: portable.replace(/^\/+/, "") };
  }

  const drive = portable.match(/^([A-Za-z]):\/(.*)$/);
  if (drive) {
    return {
      prefix: `${drive[1]?.toUpperCase()}:/`,
      remainder: drive[2] ?? "",
    };
  }

  const unc = portable.match(/^\/\/([^/]+)\/([^/]+)\/?(.*)$/);
  if (unc) {
    return {
      prefix: `//${unc[1]}/${unc[2]}`,
      remainder: unc[3] ?? "",
    };
  }

  throw new PermissionProfileResolutionError(
    "invalid_path",
    `Path '${portable}' has an invalid absolute prefix.`,
  );
}

function normalizeRelativePath(
  value: string,
  escapeCode: "path_outside_workspace" | "invalid_path",
): string {
  const portable = value.replace(/\\/g, "/");
  return normalizeSegments(portable.split("/"), escapeCode).join("/");
}

function normalizeSegments(
  segments: readonly string[],
  escapeCode: "path_outside_workspace" | "invalid_path",
): string[] {
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (normalized.length === 0) {
        throw new PermissionProfileResolutionError(
          escapeCode,
          "Filesystem path escapes its declared root.",
        );
      }
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized;
}
