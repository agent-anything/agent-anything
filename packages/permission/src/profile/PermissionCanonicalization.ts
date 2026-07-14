import type { ManagedFileSystemTarget } from "@agent-anything/governance/managed-permission";
import type {
  PermissionEnvironmentPlatform,
  PermissionFileSystemTarget,
  PermissionResolutionEnvironmentInput,
  ResolvedPermissionFileSystemTarget,
  ResolvedPermissionWorkspaceRoot,
} from "./PermissionProfile.js";
import { PermissionProfileResolutionError } from "./PermissionProfileResolutionError.js";

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const GLOB_CHARACTER_PATTERN = /[*?[\]{}]/;

export interface CanonicalPermissionWorkspaceRoot
  extends ResolvedPermissionWorkspaceRoot {}

export function resolvePermissionWorkspaceRoots(
  environment: PermissionResolutionEnvironmentInput,
): readonly CanonicalPermissionWorkspaceRoot[] {
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

      const canonicalPath = canonicalizePermissionAbsolutePath(
        root.path,
        environment.platform,
      );
      const comparablePath = comparisonKey(canonicalPath, environment.platform);
      if (canonicalPaths.has(comparablePath)) {
        throw new PermissionProfileResolutionError(
          "duplicate_workspace_root",
          `Workspace root path '${canonicalPath}' is duplicated.`,
        );
      }
      canonicalPaths.add(comparablePath);
      return { rootId: root.rootId, canonicalPath };
    })
    .sort((left, right) => left.rootId.localeCompare(right.rootId));
}

export function canonicalizePermissionFileSystemTarget(
  target: PermissionFileSystemTarget | ManagedFileSystemTarget,
  roots: readonly CanonicalPermissionWorkspaceRoot[],
  platform: PermissionEnvironmentPlatform,
): ResolvedPermissionFileSystemTarget {
  switch (target.kind) {
    case "absolute_path":
      return {
        kind: "absolute_path",
        path: canonicalizePermissionAbsolutePath(target.path, platform),
      };
    case "workspace_path":
      return {
        kind: "absolute_path",
        path: resolvePermissionWorkspacePath(
          target.path,
          findPermissionWorkspaceRoot(target.rootId, roots),
          platform,
        ),
      };
    case "absolute_glob":
      return {
        kind: "canonical_glob",
        pattern: canonicalizePermissionAbsoluteGlob(target.pattern, platform),
      };
    case "workspace_glob":
      return {
        kind: "canonical_glob",
        pattern: joinPortable(
          findPermissionWorkspaceRoot(target.rootId, roots).canonicalPath,
          canonicalizePermissionRelativeGlob(target.pattern),
        ),
      };
    default:
      throw new PermissionProfileResolutionError(
        "invalid_path",
        "Filesystem target kind is invalid.",
      );
  }
}

export function canonicalizePermissionPathFromCwd(
  value: string,
  cwd: string,
  platform: PermissionEnvironmentPlatform,
): string {
  const canonicalCwd = canonicalizePermissionAbsolutePath(cwd, platform);
  if (isPermissionAbsolutePath(value, platform)) {
    return canonicalizePermissionAbsolutePath(value, platform);
  }
  validatePathText(value);
  if (GLOB_CHARACTER_PATTERN.test(value)) {
    throw new PermissionProfileResolutionError(
      "invalid_path",
      `Permission path '${value}' contains glob characters.`,
    );
  }
  return canonicalizePermissionAbsolutePath(joinPortable(canonicalCwd, value), platform);
}

export function canonicalizePermissionAbsolutePath(
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
  if (!isPermissionAbsolutePath(portable, platform)) {
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

export function canonicalizePermissionDomains(
  domains: readonly string[],
): readonly string[] {
  return [...new Set(domains.map(canonicalizePermissionDomain))].sort(
    (left, right) => left.localeCompare(right),
  );
}

export function canonicalizePermissionDomain(value: string): string {
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

export function matchesPermissionFileSystemTarget(
  target: ResolvedPermissionFileSystemTarget,
  canonicalPath: string,
  platform: PermissionEnvironmentPlatform,
): boolean {
  const candidate = comparisonKey(canonicalPath, platform);
  if (target.kind === "absolute_path") {
    const base = comparisonKey(target.path, platform);
    return candidate === base || candidate.startsWith(`${trimTrailingSlash(base)}/`);
  }
  const pattern = comparisonKey(target.pattern, platform);
  return globToRegExp(pattern).test(candidate);
}

export function matchesPermissionDomainPattern(
  pattern: string,
  domain: string,
): boolean {
  return pattern.startsWith("*.")
    ? domain.endsWith(`.${pattern.slice(2)}`)
    : domain === pattern;
}

function findPermissionWorkspaceRoot(
  rootId: string,
  roots: readonly CanonicalPermissionWorkspaceRoot[],
): CanonicalPermissionWorkspaceRoot {
  const root = roots.find((candidate) => candidate.rootId === rootId);
  if (!root) {
    throw new PermissionProfileResolutionError(
      "unknown_workspace_root",
      `Workspace root '${rootId}' is not part of the permission environment.`,
    );
  }
  return root;
}

function resolvePermissionWorkspacePath(
  relativePath: string,
  root: CanonicalPermissionWorkspaceRoot,
  platform: PermissionEnvironmentPlatform,
): string {
  validatePathText(relativePath);
  if (GLOB_CHARACTER_PATTERN.test(relativePath)) {
    throw new PermissionProfileResolutionError(
      "invalid_path",
      `Workspace path '${relativePath}' contains glob characters.`,
    );
  }
  if (isPermissionAbsolutePath(relativePath, platform)) {
    throw new PermissionProfileResolutionError(
      "invalid_path",
      `Workspace path '${relativePath}' must be relative.`,
    );
  }
  const normalized = normalizeRelativePath(
    relativePath,
    "path_outside_workspace",
  );
  return normalized.length === 0
    ? root.canonicalPath
    : joinPortable(root.canonicalPath, normalized);
}

function canonicalizePermissionAbsoluteGlob(
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
  return joinPortable(
    canonicalizePermissionAbsolutePath(base, platform),
    canonicalizePermissionRelativeGlob(portable.slice(base.length)),
  );
}

function canonicalizePermissionRelativeGlob(pattern: string): string {
  validatePathText(pattern);
  const portable = pattern.replace(/\\/g, "/");
  if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable)) {
    throw new PermissionProfileResolutionError(
      "invalid_glob",
      `Workspace glob '${pattern}' must be relative.`,
    );
  }
  const segments = portable
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
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

function isPermissionAbsolutePath(
  value: string,
  platform: PermissionEnvironmentPlatform,
): boolean {
  const portable = value.replace(/\\/g, "/");
  return platform === "posix"
    ? portable.startsWith("/")
    : /^[A-Za-z]:\//.test(portable) ||
        /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(portable);
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
  return normalizeSegments(value.replace(/\\/g, "/").split("/"), escapeCode).join(
    "/",
  );
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

function validatePathText(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new PermissionProfileResolutionError(
      "invalid_path",
      "Filesystem path must be a non-empty string without null bytes.",
    );
  }
}

function comparisonKey(
  value: string,
  platform: PermissionEnvironmentPlatform,
): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

function joinPortable(base: string, suffix: string): string {
  return base.endsWith("/") ? `${base}${suffix}` : `${base}/${suffix}`;
}

function trimTrailingSlash(value: string): string {
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(character ?? "");
    }
  }
  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
