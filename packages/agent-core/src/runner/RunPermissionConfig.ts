import {
  snapshotExecPolicyRule,
  type ExecPolicyRule,
  type ManagedPermissionConstraints,
  type NetworkPolicyRule,
  type PersistentPolicyAmendmentPort,
  snapshotNetworkPolicyRule,
} from "@agent-anything/governance";
import {
  canonicalizePermissionAbsolutePath,
  canonicalizePermissionDomains,
  canonicalizePermissionFileSystemTarget,
  validateSessionAuthorityRecord,
  type ApprovalPolicy,
  type ApprovalReviewerDescriptor,
  type ApprovalReviewerPort,
  type ApprovalsReviewer,
  type ResolvedPermissionProfile,
  type SessionAuthorityContext,
  type SessionAuthorityPort,
  type SessionAuthorityRecord,
} from "@agent-anything/permission";
import type { ISODateTimeString } from "@agent-anything/shared";
import type { IdentityRef, WorkspaceContext } from "@agent-anything/governance";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ApprovalReviewerBinding {
  readonly bindingId: string;
  readonly kind: ApprovalsReviewer;
  readonly reviewer: ApprovalReviewerPort;
  readonly descriptor: ApprovalReviewerDescriptor;
  readonly reviewTimeoutMs: number | null;
}

export interface ApprovalLimits {
  readonly maxRequestsPerRun: number;
  readonly maxRequestsPerActionFingerprint: number;
  readonly maxConsecutiveDeclines: number;
  readonly maxConsecutiveReviewFailures: number;
}

export interface AuthorityApplicationLimits {
  readonly commitTimeoutMs: number;
}

export interface ResolvedSessionAuthorityConfig {
  readonly context: SessionAuthorityContext;
  readonly initialRecords: readonly SessionAuthorityRecord[];
  readonly port: SessionAuthorityPort;
}

export interface ResolvedRunPermissionConfig {
  readonly permissionProfile: ResolvedPermissionProfile;
  readonly approvalPolicy: ApprovalPolicy;
  readonly reviewer: ApprovalReviewerBinding | null;
  readonly rules: readonly ExecPolicyRule[];
  readonly networkRules: readonly NetworkPolicyRule[];
  readonly managedConstraints: ManagedPermissionConstraints;
  readonly sessionAuthority: ResolvedSessionAuthorityConfig | null;
  readonly persistentPolicyAmendments: PersistentPolicyAmendmentPort | null;
  readonly approvalLimits: ApprovalLimits;
  readonly authorityApplicationLimits: AuthorityApplicationLimits;
}

export interface SnapshotResolvedRunPermissionConfigInput {
  readonly permissions: ResolvedRunPermissionConfig;
  readonly workspace: WorkspaceContext;
  readonly identity: IdentityRef;
}

export function snapshotResolvedRunPermissionConfig(
  input: SnapshotResolvedRunPermissionConfigInput,
): ResolvedRunPermissionConfig {
  if (!input.permissions || typeof input.permissions !== "object") {
    throw new TypeError("RunConfig.permissions must be a resolved permission configuration.");
  }
  const profile = snapshotPermissionProfile(input.permissions.permissionProfile);
  const managedConstraints = snapshotManagedConstraints(
    input.permissions.managedConstraints,
    profile,
  );
  if (profile.managedConstraintSetId !== managedConstraints.constraintSetId) {
    throw new TypeError(
      "Permission profile and managed constraints must use the same constraint set.",
    );
  }
  if (
    profile.enforcement === "disabled" &&
    !managedConstraints.allowUnenforcedExecution
  ) {
    throw new TypeError("Managed constraints reject disabled permission enforcement.");
  }

  const approvalPolicy = snapshotApprovalPolicy(input.permissions.approvalPolicy);
  const reviewer = snapshotReviewerBinding(input.permissions.reviewer);
  const reviewCapable = isReviewCapablePolicy(approvalPolicy);
  if (reviewCapable !== (reviewer !== null)) {
    throw new TypeError(
      reviewCapable
        ? "A review-capable approval policy requires a reviewer binding."
        : "A non-reviewing approval policy must not carry a reviewer binding.",
    );
  }

  const rules = snapshotRules(input.permissions.rules);
  for (const rule of rules) {
    if (
      rule.cwd !== null &&
      canonicalizePermissionAbsolutePath(rule.cwd, profile.platform) !== rule.cwd
    ) {
      throw new TypeError(
        `ExecPolicyRule '${rule.id}' cwd must already be canonical for ${profile.platform}.`,
      );
    }
  }
  const networkRules = snapshotNetworkRules(input.permissions.networkRules);
  const approvalLimits = snapshotApprovalLimits(input.permissions.approvalLimits);
  const authorityApplicationLimits = snapshotAuthorityApplicationLimits(
    input.permissions.authorityApplicationLimits,
  );
  const sessionAuthority = snapshotSessionAuthority({
    config: input.permissions.sessionAuthority,
    profile,
    managedConstraints,
    workspace: input.workspace,
    identity: input.identity,
  });
  const persistentPolicyAmendments =
    input.permissions.persistentPolicyAmendments;
  if (
    persistentPolicyAmendments !== null &&
    (typeof persistentPolicyAmendments !== "object" ||
      typeof persistentPolicyAmendments.commit !== "function")
  ) {
    throw new TypeError(
      "Persistent policy amendments must provide a commit port or be null.",
    );
  }

  return Object.freeze({
    permissionProfile: profile,
    approvalPolicy,
    reviewer,
    rules,
    networkRules,
    managedConstraints,
    sessionAuthority,
    persistentPolicyAmendments,
    approvalLimits,
    authorityApplicationLimits,
  });
}

export function isReviewCapablePolicy(policy: ApprovalPolicy): boolean {
  if (policy === "never") return false;
  if (policy === "untrusted" || policy === "on-request") return true;
  return Object.values(policy.granular).some(Boolean);
}

export function deriveRunDeadline(
  startedAt: ISODateTimeString,
  maxDurationMs: number,
): ISODateTimeString {
  return addBoundedDuration(startedAt, maxDurationMs, "Run deadline");
}

export function deriveApprovalReviewDeadline(input: {
  readonly runDeadlineAt: ISODateTimeString;
  readonly reviewStartedAt: ISODateTimeString;
  readonly reviewTimeoutMs: number | null;
}): ISODateTimeString {
  const runDeadlineMs = parseDateTime(input.runDeadlineAt, "runDeadlineAt");
  if (input.reviewTimeoutMs === null) return input.runDeadlineAt;
  const reviewDeadline = addBoundedDuration(
    input.reviewStartedAt,
    input.reviewTimeoutMs,
    "Approval review deadline",
  );
  return Date.parse(reviewDeadline) < runDeadlineMs
    ? reviewDeadline
    : input.runDeadlineAt;
}

export function deriveAuthorityCommitDeadline(input: {
  readonly runDeadlineAt: ISODateTimeString;
  readonly commitStartedAt: ISODateTimeString;
  readonly commitTimeoutMs: number;
}): ISODateTimeString {
  const runDeadlineMs = parseDateTime(input.runDeadlineAt, "runDeadlineAt");
  const commitDeadline = addBoundedDuration(
    input.commitStartedAt,
    input.commitTimeoutMs,
    "Authority commit deadline",
  );
  return Date.parse(commitDeadline) < runDeadlineMs
    ? commitDeadline
    : input.runDeadlineAt;
}

function snapshotReviewerBinding(
  binding: ApprovalReviewerBinding | null,
): ApprovalReviewerBinding | null {
  if (binding === null) return null;
  if (typeof binding !== "object") {
    throw new TypeError("Approval reviewer binding must be an object or null.");
  }
  assertNonEmpty(binding.bindingId, "ApprovalReviewerBinding.bindingId");
  if (binding.kind !== "user" && binding.kind !== "auto_review") {
    throw new TypeError("ApprovalReviewerBinding.kind is unsupported.");
  }
  if (!binding.reviewer || typeof binding.reviewer.review !== "function") {
    throw new TypeError("ApprovalReviewerBinding.reviewer must provide review().");
  }
  const descriptor = binding.descriptor;
  if (!descriptor || typeof descriptor !== "object") {
    throw new TypeError("ApprovalReviewerBinding.descriptor must be an object.");
  }
  assertNonEmpty(descriptor.id, "ApprovalReviewerDescriptor.id");
  assertNonEmpty(descriptor.displayName, "ApprovalReviewerDescriptor.displayName");
  assertNonEmpty(descriptor.source, "ApprovalReviewerDescriptor.source");
  if (descriptor.kind !== binding.kind) {
    throw new TypeError("Reviewer binding and descriptor kinds must match.");
  }
  if (!isRecord(descriptor.metadata)) {
    throw new TypeError("ApprovalReviewerDescriptor.metadata must be an object.");
  }
  if (binding.kind === "auto_review" && binding.reviewTimeoutMs === null) {
    throw new TypeError("An automatic reviewer requires a finite timeout.");
  }
  if (binding.reviewTimeoutMs !== null) {
    assertPositiveTimer(binding.reviewTimeoutMs, "reviewTimeoutMs");
  }

  return Object.freeze({
    bindingId: binding.bindingId,
    kind: binding.kind,
    reviewer: binding.reviewer,
    descriptor: Object.freeze({
      ...descriptor,
      metadata: deepFreezeClone(descriptor.metadata),
    }),
    reviewTimeoutMs: binding.reviewTimeoutMs,
  });
}

function snapshotApprovalPolicy(policy: ApprovalPolicy): ApprovalPolicy {
  if (policy === "untrusted" || policy === "on-request" || policy === "never") {
    return policy;
  }
  if (!isRecord(policy) || !isRecord(policy.granular)) {
    throw new TypeError("ApprovalPolicy is invalid.");
  }
  const granular = policy.granular;
  for (const field of [
    "sandboxApproval",
    "rules",
    "mcpElicitations",
    "requestPermissions",
    "skillApproval",
  ] as const) {
    if (typeof granular[field] !== "boolean") {
      throw new TypeError(`ApprovalPolicy.granular.${field} must be boolean.`);
    }
  }
  return Object.freeze({ granular: Object.freeze({ ...granular }) });
}

function snapshotRules(rules: readonly ExecPolicyRule[]): readonly ExecPolicyRule[] {
  if (!Array.isArray(rules)) throw new TypeError("Permission Rules must be an array.");
  const ids = new Set<string>();
  return Object.freeze(rules.map((rule) => {
    const snapshot = snapshotExecPolicyRule(rule);
    if (ids.has(snapshot.id)) {
      throw new TypeError(`ExecPolicyRule id '${snapshot.id}' is duplicated.`);
    }
    ids.add(snapshot.id);
    return snapshot;
  }));
}

function snapshotNetworkRules(
  rules: readonly NetworkPolicyRule[],
): readonly NetworkPolicyRule[] {
  if (!Array.isArray(rules)) throw new TypeError("Network Rules must be an array.");
  const ids = new Set<string>();
  return Object.freeze(rules.map((rule) => {
    const snapshot = snapshotNetworkPolicyRule(rule);
    if (ids.has(snapshot.id)) {
      throw new TypeError(`NetworkPolicyRule id '${snapshot.id}' is duplicated.`);
    }
    ids.add(snapshot.id);
    return snapshot;
  }));
}

function snapshotPermissionProfile(
  profile: ResolvedPermissionProfile,
): ResolvedPermissionProfile {
  if (!profile || typeof profile !== "object") {
    throw new TypeError("Resolved permission profile must be an object.");
  }
  assertNonEmpty(profile.id, "ResolvedPermissionProfile.id");
  assertNonEmpty(profile.environmentId, "ResolvedPermissionProfile.environmentId");
  assertNonEmpty(
    profile.managedConstraintSetId,
    "ResolvedPermissionProfile.managedConstraintSetId",
  );
  if (profile.platform !== "win32" && profile.platform !== "posix") {
    throw new TypeError("ResolvedPermissionProfile.platform is unsupported.");
  }
  if (
    profile.enforcement !== "managed" &&
    profile.enforcement !== "external" &&
    profile.enforcement !== "disabled"
  ) {
    throw new TypeError("ResolvedPermissionProfile.enforcement is unsupported.");
  }
  if (!Array.isArray(profile.sourceProfileIds) || profile.sourceProfileIds.length === 0) {
    throw new TypeError("ResolvedPermissionProfile requires source profile ids.");
  }
  const sourceProfileIds = new Set<string>();
  profile.sourceProfileIds.forEach((id) => {
    assertNonEmpty(id, "ResolvedPermissionProfile.sourceProfileIds");
    if (sourceProfileIds.has(id)) {
      throw new TypeError(`Permission source profile '${id}' is duplicated.`);
    }
    sourceProfileIds.add(id);
  });
  if (!Array.isArray(profile.workspaceRoots)) {
    throw new TypeError("ResolvedPermissionProfile.workspaceRoots must be an array.");
  }
  const rootIds = new Set<string>();
  for (const root of profile.workspaceRoots) {
    assertNonEmpty(root.rootId, "ResolvedPermissionProfile.workspaceRoot.rootId");
    assertNonEmpty(
      root.canonicalPath,
      "ResolvedPermissionProfile.workspaceRoot.canonicalPath",
    );
    if (rootIds.has(root.rootId)) {
      throw new TypeError(`Permission workspace root '${root.rootId}' is duplicated.`);
    }
    if (
      canonicalizePermissionAbsolutePath(root.canonicalPath, profile.platform) !==
      root.canonicalPath
    ) {
      throw new TypeError(
        `Permission workspace root '${root.rootId}' must already be canonical.`,
      );
    }
    rootIds.add(root.rootId);
  }
  if (!profile.fileSystem || !Array.isArray(profile.fileSystem.entries) ||
      !Array.isArray(profile.fileSystem.managedCeilings)) {
    throw new TypeError("ResolvedPermissionProfile.fileSystem is invalid.");
  }
  if (typeof profile.fileSystem.unrestricted !== "boolean") {
    throw new TypeError("ResolvedPermissionProfile.fileSystem.unrestricted must be boolean.");
  }
  for (const entry of profile.fileSystem.entries) {
    snapshotResolvedFileSystemTarget(entry.target, profile);
    if (entry.access !== "read" && entry.access !== "write" && entry.access !== "deny") {
      throw new TypeError("Resolved permission filesystem access is unsupported.");
    }
    if (!sourceProfileIds.has(entry.sourceProfileId)) {
      throw new TypeError(
        `Resolved permission entry references unknown source profile '${entry.sourceProfileId}'.`,
      );
    }
    assertNonNegativeSafeInteger(
      entry.specificity,
      "ResolvedPermissionProfile.fileSystem.entry.specificity",
    );
  }
  for (const ceiling of profile.fileSystem.managedCeilings) {
    snapshotResolvedFileSystemTarget(ceiling.target, profile);
    if (ceiling.maximumAccess !== "read" && ceiling.maximumAccess !== "none") {
      throw new TypeError("Resolved managed filesystem maximum access is unsupported.");
    }
    if (ceiling.sourceConstraintSetId !== profile.managedConstraintSetId) {
      throw new TypeError(
        "Resolved managed filesystem ceiling must reference the active constraint set.",
      );
    }
    assertNonNegativeSafeInteger(
      ceiling.specificity,
      "ResolvedPermissionProfile.fileSystem.managedCeiling.specificity",
    );
  }
  if (!profile.network || typeof profile.network.enabled !== "boolean") {
    throw new TypeError("ResolvedPermissionProfile.network is invalid.");
  }
  const profileAllowedDomains = canonicalizeAndRequireEqual(
    profile.network.profileAllowedDomains,
    "profileAllowedDomains",
  );
  const managedAllowedDomains = canonicalizeAndRequireEqual(
    profile.network.managedAllowedDomains,
    "managedAllowedDomains",
  );
  const deniedDomains = canonicalizeAndRequireEqual(
    profile.network.deniedDomains,
    "deniedDomains",
  );
  if (!isRecord(profile.metadata)) {
    throw new TypeError("ResolvedPermissionProfile.metadata must be an object.");
  }

  return deepFreezeClone({
    ...profile,
    sourceProfileIds: [...profile.sourceProfileIds],
    workspaceRoots: profile.workspaceRoots.map((root) => ({ ...root })),
    fileSystem: {
      unrestricted: profile.fileSystem.unrestricted,
      entries: profile.fileSystem.entries.map((entry) => ({
        ...entry,
        target: { ...entry.target },
      })),
      managedCeilings: profile.fileSystem.managedCeilings.map((ceiling) => ({
        ...ceiling,
        target: { ...ceiling.target },
      })),
    },
    network: {
      enabled: profile.network.enabled,
      profileAllowedDomains,
      managedAllowedDomains,
      deniedDomains,
    },
    metadata: { ...profile.metadata },
  });
}

function snapshotManagedConstraints(
  constraints: ManagedPermissionConstraints,
  profile: ResolvedPermissionProfile,
): ManagedPermissionConstraints {
  if (!constraints || typeof constraints !== "object") {
    throw new TypeError("Managed permission constraints must be an object.");
  }
  assertNonEmpty(constraints.constraintSetId, "ManagedPermissionConstraints.constraintSetId");
  if (!constraints.selectableProfiles || !Array.isArray(constraints.selectableProfiles.deniedProfileIds) ||
      (constraints.selectableProfiles.allowedProfileIds !== null &&
        !Array.isArray(constraints.selectableProfiles.allowedProfileIds))) {
    throw new TypeError("Managed profile selection constraints are invalid.");
  }
  if (!Array.isArray(constraints.fileSystem) || !constraints.network) {
    throw new TypeError("Managed permission constraints are invalid.");
  }
  const allowedProfileIds = constraints.selectableProfiles.allowedProfileIds === null
    ? null
    : snapshotUniqueStrings(
        constraints.selectableProfiles.allowedProfileIds,
        "ManagedPermissionConstraints.selectableProfiles.allowedProfileIds",
      );
  const deniedProfileIds = snapshotUniqueStrings(
    constraints.selectableProfiles.deniedProfileIds,
    "ManagedPermissionConstraints.selectableProfiles.deniedProfileIds",
  );
  if (deniedProfileIds.includes(profile.id)) {
    throw new TypeError(`Managed constraints deny active profile '${profile.id}'.`);
  }
  if (allowedProfileIds !== null && !allowedProfileIds.includes(profile.id)) {
    throw new TypeError(`Managed constraints do not allow active profile '${profile.id}'.`);
  }
  for (const constraint of constraints.fileSystem) {
    if (constraint.maximumAccess !== "read" && constraint.maximumAccess !== "none") {
      throw new TypeError("Managed filesystem maximum access is unsupported.");
    }
    canonicalizePermissionFileSystemTarget(
      constraint.target,
      profile.workspaceRoots,
      profile.platform,
    );
  }
  if (constraints.network.enabled !== null &&
      typeof constraints.network.enabled !== "boolean") {
    throw new TypeError("Managed network enabled must be boolean or null.");
  }
  const allowedDomains = canonicalizeAndRequireEqual(
    constraints.network.allowedDomains,
    "ManagedPermissionConstraints.network.allowedDomains",
  );
  const deniedDomains = canonicalizeAndRequireEqual(
    constraints.network.deniedDomains,
    "ManagedPermissionConstraints.network.deniedDomains",
  );
  if (typeof constraints.allowUnenforcedExecution !== "boolean") {
    throw new TypeError("allowUnenforcedExecution must be boolean.");
  }
  return deepFreezeClone({
    ...constraints,
    selectableProfiles: {
      allowedProfileIds,
      deniedProfileIds,
    },
    fileSystem: constraints.fileSystem.map((constraint) => ({
      ...constraint,
      target: { ...constraint.target },
    })),
    network: {
      enabled: constraints.network.enabled,
      allowedDomains,
      deniedDomains,
    },
  });
}

function snapshotResolvedFileSystemTarget(
  target: ResolvedPermissionProfile["fileSystem"]["entries"][number]["target"],
  profile: ResolvedPermissionProfile,
): void {
  if (!target || typeof target !== "object") {
    throw new TypeError("Resolved filesystem target must be an object.");
  }
  const canonical = target.kind === "absolute_path"
    ? canonicalizePermissionFileSystemTarget(target, profile.workspaceRoots, profile.platform)
    : target.kind === "canonical_glob"
      ? canonicalizePermissionFileSystemTarget(
          { kind: "absolute_glob", pattern: target.pattern },
          profile.workspaceRoots,
          profile.platform,
        )
      : null;
  if (canonical === null) {
    throw new TypeError("Resolved filesystem target kind is unsupported.");
  }
  const actualValue = target.kind === "absolute_path" ? target.path : target.pattern;
  const canonicalValue = canonical.kind === "absolute_path"
    ? canonical.path
    : canonical.pattern;
  if (canonical.kind !== target.kind || canonicalValue !== actualValue) {
    throw new TypeError("Resolved filesystem target must already be canonical.");
  }
}

function snapshotUniqueStrings(
  values: readonly string[],
  field: string,
): readonly string[];
function snapshotUniqueStrings(
  values: readonly string[],
  field: string,
): readonly string[] {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array.`);
  const unique = new Set<string>();
  for (const value of values) {
    assertNonEmpty(value, field);
    if (unique.has(value)) throw new TypeError(`${field} contains duplicate '${value}'.`);
    unique.add(value);
  }
  return Object.freeze([...values]);
}

function snapshotSessionAuthority(input: {
  readonly config: ResolvedSessionAuthorityConfig | null;
  readonly profile: ResolvedPermissionProfile;
  readonly managedConstraints: ManagedPermissionConstraints;
  readonly workspace: WorkspaceContext;
  readonly identity: IdentityRef;
}): ResolvedSessionAuthorityConfig | null {
  if (input.config === null) return null;
  const config = input.config;
  if (!config || typeof config !== "object" ||
      !config.port || typeof config.port.listApplicable !== "function" ||
      typeof config.port.commit !== "function") {
    throw new TypeError("Resolved Session authority requires a valid port.");
  }
  const context = snapshotSessionAuthorityContext(config.context);
  const expectedIdentityId = input.identity.kind === "anonymous"
    ? null
    : input.identity.id;
  if (
    context.workspaceId !== input.workspace.id ||
    context.identityId !== expectedIdentityId ||
    context.environmentId !== input.profile.environmentId
  ) {
    throw new TypeError(
      "Session authority context does not match Run workspace, identity, or environment.",
    );
  }
  if (!Array.isArray(config.initialRecords)) {
    throw new TypeError("Session authority initialRecords must be an array.");
  }
  const environment = {
    environmentId: input.profile.environmentId,
    platform: input.profile.platform,
    workspaceRoots: input.profile.workspaceRoots.map((root) => ({
      rootId: root.rootId,
      path: root.canonicalPath,
    })),
  } as const;
  const cwd = input.profile.workspaceRoots[0]?.canonicalPath ??
    (input.profile.platform === "win32" ? "C:/" : "/");
  const ids = new Set<string>();
  const initialRecords = config.initialRecords.map((record) => {
    const validated = validateSessionAuthorityRecord({
      record,
      expectedContext: context,
      cwd,
      environment,
      managedConstraints: input.managedConstraints,
    });
    if (validated.status === "invalid") {
      throw new TypeError(`Invalid Session authority record: ${validated.message}`);
    }
    if (ids.has(validated.record.id)) {
      throw new TypeError(`Session authority record '${validated.record.id}' is duplicated.`);
    }
    ids.add(validated.record.id);
    return validated.record;
  });
  return Object.freeze({
    context,
    initialRecords: Object.freeze(initialRecords),
    port: config.port,
  });
}

function snapshotSessionAuthorityContext(
  context: SessionAuthorityContext,
): SessionAuthorityContext {
  if (!context || typeof context !== "object") {
    throw new TypeError("SessionAuthorityContext must be an object.");
  }
  assertNonEmpty(context.hostSessionId, "SessionAuthorityContext.hostSessionId");
  assertNonEmpty(
    context.authorityContextKey,
    "SessionAuthorityContext.authorityContextKey",
  );
  assertNonEmpty(context.workspaceId, "SessionAuthorityContext.workspaceId");
  if (context.identityId !== null) {
    assertNonEmpty(context.identityId, "SessionAuthorityContext.identityId");
  }
  assertNonEmpty(context.environmentId, "SessionAuthorityContext.environmentId");
  return Object.freeze({ ...context });
}

function snapshotApprovalLimits(limits: ApprovalLimits): ApprovalLimits {
  if (!limits || typeof limits !== "object") {
    throw new TypeError("ApprovalLimits must be an object.");
  }
  for (const field of [
    "maxRequestsPerRun",
    "maxRequestsPerActionFingerprint",
    "maxConsecutiveDeclines",
    "maxConsecutiveReviewFailures",
  ] as const) {
    assertPositiveInteger(limits[field], `ApprovalLimits.${field}`);
  }
  return Object.freeze({ ...limits });
}

function snapshotAuthorityApplicationLimits(
  limits: AuthorityApplicationLimits,
): AuthorityApplicationLimits {
  if (!limits || typeof limits !== "object") {
    throw new TypeError("AuthorityApplicationLimits must be an object.");
  }
  assertPositiveTimer(limits.commitTimeoutMs, "commitTimeoutMs");
  return Object.freeze({ commitTimeoutMs: limits.commitTimeoutMs });
}

function canonicalizeAndRequireEqual(
  values: readonly string[],
  field: string,
): readonly string[] {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array.`);
  const canonical = canonicalizePermissionDomains(values);
  if (
    canonical.length !== values.length ||
    canonical.some((value, index) => value !== values[index])
  ) {
    throw new TypeError(`${field} must already be canonical, unique, and sorted.`);
  }
  return canonical;
}

function addBoundedDuration(
  startedAt: ISODateTimeString,
  durationMs: number,
  field: string,
): ISODateTimeString {
  const startedAtMs = parseDateTime(startedAt, `${field}.startedAt`);
  assertPositiveTimer(durationMs, `${field}.durationMs`);
  const deadlineMs = startedAtMs + durationMs;
  if (!Number.isSafeInteger(deadlineMs)) {
    throw new TypeError(`${field} exceeds the supported date range.`);
  }
  const date = new Date(deadlineMs);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${field} is invalid.`);
  }
  return date.toISOString();
}

function parseDateTime(value: ISODateTimeString, field: string): number {
  const parsed = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(parsed)) {
    throw new TypeError(`${field} must be a valid date-time string.`);
  }
  return parsed;
}

function assertPositiveTimer(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(
      `${field} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}.`,
    );
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreezeClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepFreezeClone(item))) as T;
  }
  if (isRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      clone[key] = deepFreezeClone(child);
    }
    return Object.freeze(clone) as T;
  }
  return value;
}
