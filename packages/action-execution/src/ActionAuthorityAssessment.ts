import type { ActionRuleOutcome } from "@agent-anything/governance";
import {
  isActionApprovalCoverageApplicable,
  isSessionAuthorityApplicable,
  matchesPermissionDomainPattern,
  matchesPermissionFileSystemTarget,
  validateGrantedPermissions,
  type CanonicalAdditionalPermissions,
  type GrantedPermissions,
} from "@agent-anything/permission";
import type { ActionAssessmentAuthoritySnapshot, ActionAuthoritySource } from "./ActionAssessment.js";
import { createCanonicalEffectivePermissions } from "./CanonicalEffectivePermissions.js";
import type { PreparedExternalAction } from "./PreparedExternalAction.js";
import type {
  CanonicalExecutableIdentity,
  CanonicalFileSystemTarget,
  CanonicalNetworkEndpoint,
  CanonicalPathIdentity,
  CanonicalRemoteToolIdentity,
} from "./CanonicalIdentity.js";

export type ManagedActionCheckResult =
  | { readonly status: "allowed" }
  | { readonly status: "invalidated"; readonly code: string; readonly message: string }
  | { readonly status: "denied"; readonly code: string; readonly message: string };

export interface DerivedActionAuthority {
  readonly fullyCovered: boolean;
  readonly hasCategoryAuthority: boolean;
  readonly missingPermissions: CanonicalAdditionalPermissions | null;
  readonly sources: readonly ActionAuthoritySource[];
  readonly actionCoverageIdToConsume: string | null;
  readonly effectivePermissions: ReturnType<typeof createCanonicalEffectivePermissions>;
}

export function checkManagedActionConstraints(
  prepared: PreparedExternalAction,
  authority: ActionAssessmentAuthoritySnapshot,
): ManagedActionCheckResult {
  const profile = authority.profile;
  const constraints = authority.managedConstraints;
  if (profile.managedConstraintSetId !== constraints.constraintSetId ||
    profile.environmentId !== prepared.subject.environment.environmentId ||
    profile.platform !== prepared.subject.environment.platform) {
    return Object.freeze({
      status: "invalidated",
      code: "permission_assessment_context_mismatch",
      message: "The permission assessment context no longer matches the prepared Action.",
    });
  }
  if (profile.enforcement === "disabled" && !constraints.allowUnenforcedExecution) {
    return Object.freeze({
      status: "denied",
      code: "policy_unenforced_execution_denied",
      message: "Managed constraints prohibit unenforced execution.",
    });
  }
  if (prepared.subject.requestedPermissions !== null) {
    const validated = validateGrantedPermissions({
      requested: prepared.subject.requestedPermissions,
      granted: prepared.subject.requestedPermissions,
      cwd: profile.workspaceRoots[0]?.canonicalPath ?? (profile.platform === "win32" ? "C:/" : "/"),
      environment: {
        environmentId: profile.environmentId,
        platform: profile.platform,
        workspaceRoots: profile.workspaceRoots.map((root) => ({ rootId: root.rootId, path: root.canonicalPath })),
      },
      managedConstraints: constraints,
    });
    if (validated.status === "invalid") {
      return Object.freeze({
        status: "denied",
        code: validated.code.replace(/^permissions_/, "permission_"),
        message: validated.message,
      });
    }
  }
  if (prepared.subject.effectSet.kind === "effects") {
    for (const effect of prepared.subject.effectSet.values) {
      if (effect.kind === "file_system") {
        for (const target of effect.targets) {
          if (!managedFileAccessAllows(authority, target, effect.operation)) {
            return Object.freeze({
              status: "denied",
              code: "permission_managed_filesystem_denied",
              message: "Managed constraints deny a filesystem effect required by the Action.",
            });
          }
        }
      }
      if (effect.kind === "network" &&
        effect.endpoints.some((endpoint) => !managedNetworkAllows(authority, endpoint.host))) {
        return Object.freeze({
          status: "denied",
          code: "permission_managed_network_denied",
          message: "Managed constraints deny a network effect required by the Action.",
        });
      }
    }
  }
  return Object.freeze({ status: "allowed" });
}

export function deriveActionAuthority(input: {
  readonly prepared: PreparedExternalAction;
  readonly authority: ActionAssessmentAuthoritySnapshot;
  readonly ruleOutcome: ActionRuleOutcome;
}): DerivedActionAuthority {
  const { prepared, authority } = input;
  const exactCoverage = authority.actionCoverage.filter((coverage) =>
    isActionApprovalCoverageApplicable(coverage, {
      runId: prepared.action.runId,
      actionId: prepared.action.id,
      actionFingerprint: prepared.actionFingerprint,
    })
  );
  if (exactCoverage.length > 1) {
    throw new TypeError("More than one exact Action approval coverage is available.");
  }
  const sessionRecords = prepared.approvalCategory === null || authority.sessionAuthorityContext === null
    ? []
    : authority.sessionAuthorityRecords.filter((record) => isSessionAuthorityApplicable(record, {
        context: authority.sessionAuthorityContext!,
        category: prepared.approvalCategory,
        applicabilityKeys: prepared.applicabilityKeys,
      }));
  const categorySessionRecords = sessionRecords.filter((record) => record.grantedPermissions === null);
  const hasCategoryAuthority = exactCoverage.length === 1 || categorySessionRecords.length > 0;
  const permissionSources = [
    ...authority.runPermissionGrants.map((grant) => ({ id: grant.id, permissions: grant.permissions, kind: "run_grant" as const })),
    ...sessionRecords.flatMap((record) => record.grantedPermissions === null ? [] : [{
      id: record.id,
      permissions: record.grantedPermissions,
      kind: "session_authority" as const,
    }]),
  ];
  const sources: ActionAuthoritySource[] = [{ kind: "profile", id: authority.profile.id }];
  sources.push(...categorySessionRecords.map((record) => ({ kind: "session_authority" as const, id: record.id })));
  if (exactCoverage[0]) sources.push({ kind: "action_coverage", id: exactCoverage[0].id });

  const fileRead: CanonicalFileSystemTarget[] = [];
  const fileWrite: CanonicalFileSystemTarget[] = [];
  const processes: CanonicalExecutableIdentity[] = [];
  const endpoints: CanonicalNetworkEndpoint[] = [];
  const remoteTools: CanonicalRemoteToolIdentity[] = [];
  const missingRead = new Set<string>();
  const missingWrite = new Set<string>();
  const missingDomains = new Set<string>();
  let uncoveredNonPermissionEffect = false;

  if (prepared.subject.effectSet.kind === "effects") {
    for (const effect of prepared.subject.effectSet.values) {
      if (effect.kind === "file_system") {
        for (const target of effect.targets) {
          const covered = hasCategoryAuthority || filePermissionAllows(authority, permissionSources, target, effect.operation);
          if (covered) {
            (effect.operation === "read" ? fileRead : fileWrite).push(target);
            collectPermissionSourceIds(sources, permissionSources, target, effect.operation);
          } else {
            (effect.operation === "read" ? missingRead : missingWrite).add(target.path.resolvedPath ?? target.path.canonicalPath);
          }
        }
      } else if (effect.kind === "network") {
        for (const endpoint of effect.endpoints) {
          const persistentAllow = hasApplicableNetworkAmendment(prepared, authority, endpoint);
          const covered = hasCategoryAuthority || persistentAllow || networkPermissionAllows(authority, permissionSources, endpoint.host);
          if (covered) {
            endpoints.push(endpoint);
            collectNetworkSourceIds(sources, permissionSources, endpoint.host);
            if (persistentAllow) collectNetworkAmendmentSources(sources, authority, endpoint);
          } else {
            missingDomains.add(endpoint.host);
          }
        }
      } else if (effect.kind === "process") {
        const persistentAllow = hasApplicableExecAmendment(prepared, authority);
        const ruleAllows = input.ruleOutcome.decision === "allow";
        if (hasCategoryAuthority || persistentAllow || ruleAllows || authority.profile.process.unrestricted) {
          processes.push(effect.executable);
          if (persistentAllow) collectExecAmendmentSources(sources, authority, prepared);
          if (ruleAllows) sources.push(...input.ruleOutcome.matchedRuleIds.map((id) => ({ kind: "rule" as const, id })));
        } else {
          uncoveredNonPermissionEffect = true;
        }
      } else {
        if (hasCategoryAuthority) remoteTools.push(effect.target);
        else uncoveredNonPermissionEffect = true;
      }
    }
  }

  if (!hasCategoryAuthority && prepared.subject.requestedPermissions !== null) {
    for (const path of prepared.subject.requestedPermissions.fileSystem?.read ?? []) {
      if (!canonicalPermissionPathCovered(authority, permissionSources, path, "read")) missingRead.add(path);
    }
    for (const path of prepared.subject.requestedPermissions.fileSystem?.write ?? []) {
      if (!canonicalPermissionPathCovered(authority, permissionSources, path, "write")) missingWrite.add(path);
    }
    if (prepared.subject.requestedPermissions.network) {
      const domains = prepared.subject.requestedPermissions.network.domains ?? [];
      if (domains.length === 0) {
        if (!unrestrictedNetworkAvailable(authority, permissionSources)) missingDomains.add("*");
      } else {
        for (const domain of domains) {
          if (!networkPermissionAllows(authority, permissionSources, domain)) missingDomains.add(domain);
        }
      }
    }
  }

  const missingPermissions = createMissingPermissions(missingRead, missingWrite, missingDomains);
  return Object.freeze({
    fullyCovered: !uncoveredNonPermissionEffect && missingPermissions === null,
    hasCategoryAuthority,
    missingPermissions,
    sources: freezeUniqueSources(sources),
    actionCoverageIdToConsume: exactCoverage[0]?.id ?? null,
    effectivePermissions: createCanonicalEffectivePermissions({
      enforcement: authority.profile.enforcement,
      fileSystem: { read: scope(fileRead.map(({ path }) => pathInput(path))), write: scope(fileWrite.map(({ path }) => pathInput(path))) },
      process: { spawn: scope(processes.map(executableInput)) },
      network: { connect: scope(endpoints) },
      remoteTool: { invoke: scope(remoteTools) },
    }),
  });
}

function filePermissionAllows(
  authority: ActionAssessmentAuthoritySnapshot,
  additions: readonly { readonly permissions: GrantedPermissions; readonly id: string }[],
  target: CanonicalFileSystemTarget,
  operation: "read" | "write",
): boolean {
  const path = target.path.resolvedPath ?? target.path.canonicalPath;
  return canonicalPermissionPathCovered(authority, additions, path, operation);
}

function canonicalPermissionPathCovered(
  authority: ActionAssessmentAuthoritySnapshot,
  additions: readonly { readonly permissions: GrantedPermissions; readonly id: string }[],
  path: string,
  operation: "read" | "write",
): boolean {
  if (!managedPathAllows(authority, path, operation)) return false;
  const profile = authority.profile;
  if (profile.fileSystem.unrestricted) return true;
  const matching = profile.fileSystem.entries.find((entry) =>
    matchesPermissionFileSystemTarget(entry.target, path, profile.platform));
  if (matching && matching.access !== "deny" &&
    (operation === "read" || matching.access === "write")) return true;
  return additions.some(({ permissions }) => {
    const values = operation === "read"
      ? [...(permissions.fileSystem?.read ?? []), ...(permissions.fileSystem?.write ?? [])]
      : [...(permissions.fileSystem?.write ?? [])];
    return values.some((base) => pathWithin(base, path, profile.platform));
  });
}

function networkPermissionAllows(
  authority: ActionAssessmentAuthoritySnapshot,
  additions: readonly { readonly permissions: GrantedPermissions; readonly id: string }[],
  host: string,
): boolean {
  if (!managedNetworkAllows(authority, host)) return false;
  const profile = authority.profile.network;
  const base = profile.enabled &&
    !profile.deniedDomains.some((pattern) => matchesPermissionDomainPattern(pattern, host)) &&
    (profile.profileAllowedDomains.length === 0 || profile.profileAllowedDomains.some((pattern) => matchesPermissionDomainPattern(pattern, host))) &&
    (profile.managedAllowedDomains.length === 0 || profile.managedAllowedDomains.some((pattern) => matchesPermissionDomainPattern(pattern, host)));
  return base || additions.some(({ permissions }) => permissions.network?.enabled === true &&
    ((permissions.network.domains?.length ?? 0) === 0 ||
      permissions.network!.domains!.some((pattern) => matchesPermissionDomainPattern(pattern, host))));
}

function unrestrictedNetworkAvailable(
  authority: ActionAssessmentAuthoritySnapshot,
  additions: readonly { readonly permissions: GrantedPermissions }[],
): boolean {
  return authority.profile.network.enabled && authority.profile.network.profileAllowedDomains.length === 0 &&
    authority.profile.network.managedAllowedDomains.length === 0 && authority.profile.network.deniedDomains.length === 0 ||
    additions.some(({ permissions }) => permissions.network?.enabled === true &&
      (permissions.network.domains?.length ?? 0) === 0);
}

function managedFileAccessAllows(
  authority: ActionAssessmentAuthoritySnapshot,
  target: CanonicalFileSystemTarget,
  operation: "read" | "write",
): boolean {
  return managedPathAllows(authority, target.path.resolvedPath ?? target.path.canonicalPath, operation);
}

function managedPathAllows(
  authority: ActionAssessmentAuthoritySnapshot,
  path: string,
  operation: "read" | "write",
): boolean {
  const ceiling = authority.profile.fileSystem.managedCeilings.find((entry) =>
    matchesPermissionFileSystemTarget(entry.target, path, authority.profile.platform));
  return ceiling === undefined || (operation === "read" && ceiling.maximumAccess === "read");
}

function managedNetworkAllows(authority: ActionAssessmentAuthoritySnapshot, host: string): boolean {
  const network = authority.managedConstraints.network;
  return network.enabled !== false &&
    !network.deniedDomains.some((pattern) => matchesPermissionDomainPattern(pattern, host)) &&
    (network.allowedDomains.length === 0 || network.allowedDomains.some((pattern) => matchesPermissionDomainPattern(pattern, host)));
}

function collectPermissionSourceIds(
  sources: ActionAuthoritySource[],
  additions: readonly { readonly id: string; readonly kind: "run_grant" | "session_authority"; readonly permissions: GrantedPermissions }[],
  target: CanonicalFileSystemTarget,
  operation: "read" | "write",
): void {
  const path = target.path.resolvedPath ?? target.path.canonicalPath;
  for (const source of additions) {
    const values = operation === "read"
      ? [...(source.permissions.fileSystem?.read ?? []), ...(source.permissions.fileSystem?.write ?? [])]
      : [...(source.permissions.fileSystem?.write ?? [])];
    if (values.some((base) => pathWithin(base, path, target.path.platform))) sources.push({ kind: source.kind, id: source.id });
  }
}

function collectNetworkSourceIds(
  sources: ActionAuthoritySource[],
  additions: readonly { readonly id: string; readonly kind: "run_grant" | "session_authority"; readonly permissions: GrantedPermissions }[],
  host: string,
): void {
  for (const source of additions) {
    if (source.permissions.network?.enabled &&
      ((source.permissions.network.domains?.length ?? 0) === 0 ||
        source.permissions.network.domains!.some((pattern) => matchesPermissionDomainPattern(pattern, host)))) {
      sources.push({ kind: source.kind, id: source.id });
    }
  }
}

function hasApplicableExecAmendment(prepared: PreparedExternalAction, authority: ActionAssessmentAuthoritySnapshot): boolean {
  if (prepared.subject.operation.kind !== "process") return false;
  const operation = prepared.subject.operation;
  const command = commandTokens(prepared);
  return authority.appliedPolicyAmendments.some(({ amendment }) => amendment.kind === "exec_policy" &&
    amendment.amendment.effect === "allow" && amendment.amendment.environmentId === authority.profile.environmentId &&
    (amendment.amendment.cwd === null || amendment.amendment.cwd === operation.cwd.canonicalPath) &&
    amendment.amendment.commandPattern.every((value, index) => value === command[index]));
}

function hasApplicableNetworkAmendment(
  prepared: PreparedExternalAction,
  authority: ActionAssessmentAuthoritySnapshot,
  endpoint: CanonicalNetworkEndpoint,
): boolean {
  return authority.appliedPolicyAmendments.some(({ amendment }) => amendment.kind === "network_policy" &&
    amendment.amendment.effect === "allow" && amendment.amendment.environmentId === authority.profile.environmentId &&
    matchesPermissionDomainPattern(amendment.amendment.hostPattern, endpoint.host) &&
    (amendment.amendment.ports.length === 0 || amendment.amendment.ports.includes(endpoint.port)) &&
    (amendment.amendment.protocols.length === 0 ||
      (endpoint.applicationProtocol !== null && amendment.amendment.protocols.includes(endpoint.applicationProtocol))));
}

function collectExecAmendmentSources(sources: ActionAuthoritySource[], authority: ActionAssessmentAuthoritySnapshot, prepared: PreparedExternalAction): void {
  if (prepared.subject.operation.kind !== "process") return;
  const command = commandTokens(prepared);
  for (const record of authority.appliedPolicyAmendments) {
    if (record.amendment.kind === "exec_policy" && record.amendment.amendment.effect === "allow" &&
      record.amendment.amendment.commandPattern.every((value, index) => value === command[index])) {
      sources.push({ kind: "policy_amendment", id: record.id });
    }
  }
}

function collectNetworkAmendmentSources(sources: ActionAuthoritySource[], authority: ActionAssessmentAuthoritySnapshot, endpoint: CanonicalNetworkEndpoint): void {
  for (const record of authority.appliedPolicyAmendments) {
    if (record.amendment.kind === "network_policy" && record.amendment.amendment.effect === "allow" &&
      matchesPermissionDomainPattern(record.amendment.amendment.hostPattern, endpoint.host)) {
      sources.push({ kind: "policy_amendment", id: record.id });
    }
  }
}

function commandTokens(prepared: PreparedExternalAction): readonly string[] {
  if (prepared.subject.operation.kind !== "process") return [];
  return [
    prepared.subject.operation.executable.path.canonicalPath,
    ...prepared.subject.operation.arguments.map((argument) => argument.kind === "literal" ? argument.value : `<secret:${argument.reference}>`),
  ];
}

function createMissingPermissions(read: Set<string>, write: Set<string>, domains: Set<string>): CanonicalAdditionalPermissions | null {
  if (read.size === 0 && write.size === 0 && domains.size === 0) return null;
  const networkDomains = [...domains].sort();
  return Object.freeze({
    ...(read.size === 0 && write.size === 0 ? {} : { fileSystem: Object.freeze({
      ...(read.size === 0 ? {} : { read: Object.freeze([...read].sort()) }),
      ...(write.size === 0 ? {} : { write: Object.freeze([...write].sort()) }),
    }) }),
    ...(domains.size === 0 ? {} : { network: Object.freeze({
      enabled: true as const,
      ...(networkDomains.includes("*") ? {} : { domains: Object.freeze(networkDomains) }),
    }) }),
  });
}

function pathWithin(base: string, candidate: string, platform: "win32" | "posix"): boolean {
  const normalize = (value: string) => (platform === "win32" ? value.toLowerCase() : value).replace(/\/$/, "");
  const parent = normalize(base);
  const child = normalize(candidate);
  return child === parent || child.startsWith(`${parent}/`);
}

function scope<T>(values: readonly T[]) {
  return values.length === 0
    ? { kind: "none" as const }
    : { kind: "restricted" as const, values };
}

function executableInput(executable: CanonicalExecutableIdentity) {
  return { path: pathInput(executable.path), baseline: executable.baseline };
}

function pathInput(path: CanonicalPathIdentity) {
  return {
    platform: path.platform,
    path: path.canonicalPath,
    resolvedPath: path.resolvedPath,
    workspaceRootId: path.workspaceRootId,
    resolutionFingerprint: path.resolutionFingerprint,
  };
}

function freezeUniqueSources(sources: readonly ActionAuthoritySource[]): readonly ActionAuthoritySource[] {
  const unique = new Map(sources.map((source) => [`${source.kind}:${source.id}`, source]));
  return Object.freeze([...unique.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)));
}
