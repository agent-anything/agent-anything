import type {
  ActionSubjectRevisionRef,
  CanonicalActionSubjectRevision,
  CapabilityEffect,
} from "@agent-anything/canonical-action/subject";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type {
  ApprovalPolicy,
  ApprovalRequirement,
} from "../approval/index.js";
import { allowsActionApproval } from "../approval/index.js";
import {
  matchesPermissionDomainPattern,
  matchesPermissionFileSystemTarget,
  type ResolvedPermissionProfile,
} from "../profile/index.js";
import type {
  ActionApprovalCoverage,
  RunPermissionGrant,
  SessionAuthorityContext,
  SessionAuthorityRecord,
} from "./AuthorityContracts.js";
import {
  isActionApprovalCoverageApplicable,
  isSessionAuthorityApplicable,
} from "./validateAuthority.js";

export type ActionPermissionReviewCause =
  | "governance_review"
  | "rule_prompt"
  | "missing_authority";

export interface ActionPermissionContext {
  readonly authoritySnapshotId: string;
  readonly profile: ResolvedPermissionProfile;
  readonly approvalPolicy: ApprovalPolicy;
  readonly actionCoverage: readonly ActionApprovalCoverage[];
  readonly runGrants: readonly RunPermissionGrant[];
  readonly sessionAuthority: readonly SessionAuthorityRecord[];
  readonly sessionAuthorityContext: SessionAuthorityContext | null;
}

export interface ActionPermissionAssessmentInput {
  readonly assessmentId: string;
  readonly actionFingerprint: string;
  readonly subject: CanonicalActionSubjectRevision;
  readonly requirement: ApprovalRequirement | null;
  readonly reviewCauses: readonly ActionPermissionReviewCause[];
  readonly context: ActionPermissionContext;
  readonly interruption: InvocationInterruptionContext;
}

export type ActionPermissionAssessment =
  | {
      readonly status: "authorized";
      readonly owner: "permission";
      readonly subject: ActionSubjectRevisionRef;
      readonly recordId: string;
      readonly revision: string;
      readonly authorityCoverageDigest: string;
      readonly actionCoverageId: string | null;
      readonly assessedAt: string;
    }
  | {
      readonly status: "approval_required";
      readonly owner: "permission";
      readonly subject: ActionSubjectRevisionRef;
      readonly recordId: string;
      readonly revision: string;
      readonly requirement: ApprovalRequirement;
      readonly assessedAt: string;
    }
  | {
      readonly status: "denied" | "failed" | "interrupted";
      readonly owner: "permission";
      readonly subject: ActionSubjectRevisionRef;
      readonly recordId: string;
      readonly revision: string;
      readonly code: string;
      readonly message: string;
      readonly assessedAt: string;
    };

export interface ActionPermissionAssessmentPort {
  assess(input: ActionPermissionAssessmentInput): Promise<ActionPermissionAssessment>;
  consumeActionCoverage(input: {
    readonly coverageId: string;
    readonly actionFingerprint: string;
    readonly subject: CanonicalActionSubjectRevision;
    readonly context: ActionPermissionContext;
    readonly interruption: InvocationInterruptionContext;
  }): Promise<
    | { readonly status: "consumed"; readonly recordId: string }
    | { readonly status: "rejected" | "failed" | "interrupted"; readonly code: string }
  >;
}

type ConsumeActionCoverageInput = Parameters<
  ActionPermissionAssessmentPort["consumeActionCoverage"]
>[0];

export interface CreateActionPermissionAssessmentPortOptions {
  readonly now?: () => string;
  readonly consumeCoverage?: (coverageId: string) => Promise<boolean> | boolean;
}

/** Default authority evaluator for one captured Run permission context. */
export function createActionPermissionAssessmentPort(
  options: CreateActionPermissionAssessmentPortOptions = {},
): ActionPermissionAssessmentPort {
  const now = options.now ?? (() => new Date().toISOString());
  const consumed = new Set<string>();
  return Object.freeze({
    async assess(input: ActionPermissionAssessmentInput): Promise<ActionPermissionAssessment> {
      const assessedAt = now();
      const base = {
        owner: "permission" as const,
        subject: input.subject.ref,
        recordId: `permission:${input.assessmentId}`,
        revision: input.context.authoritySnapshotId,
        assessedAt,
      };
      if (input.interruption.signal.aborted) {
        return Object.freeze({
          ...base,
          status: "interrupted" as const,
          code: "permission_assessment_interrupted",
          message: "Permission assessment was interrupted.",
        });
      }
      if (
        input.subject.environment.environmentId !== input.context.profile.environmentId ||
        input.subject.environment.platform !== input.context.profile.platform
      ) {
        return Object.freeze({
          ...base,
          status: "failed" as const,
          code: "permission_environment_mismatch",
          message: "Action and Permission environment identities do not match.",
        });
      }

      const exactCoverage = input.context.actionCoverage.find((coverage) =>
        !consumed.has(coverage.id) &&
        isActionApprovalCoverageApplicable(coverage, {
          runId: approvalRunId(input),
          actionId: input.subject.ref.action.id,
          actionFingerprint: input.actionFingerprint,
        })
      );
      if (exactCoverage !== undefined) {
        return authorized(base, input.context, exactCoverage.id);
      }

      if (hasApplicableSessionAuthority(input)) {
        return authorized(base, input.context, null);
      }

      const authority = assessEffects(
        input.subject.effects,
        input.context.profile,
        grantedPermissionSets(input.context),
      );
      if (authority.status === "managed_denial") {
        return Object.freeze({
          ...base,
          status: "denied" as const,
          code: authority.code,
          message: authority.message,
        });
      }

      const causes = uniqueCauses([
        ...input.reviewCauses,
        ...(authority.status === "missing" ? ["missing_authority" as const] : []),
      ]);
      if (causes.length === 0) return authorized(base, input.context, null);
      if (input.requirement === null) {
        return Object.freeze({
          ...base,
          status: "denied" as const,
          code: "permission_approval_requirement_unavailable",
          message: "The Action requires review but has no sealed approval requirement.",
        });
      }
      if (input.requirement.subject.actionFingerprint !== input.actionFingerprint) {
        return Object.freeze({
          ...base,
          status: "failed" as const,
          code: "permission_approval_subject_mismatch",
          message: "Approval requirement does not match the assessed Action fingerprint.",
        });
      }
      const disallowedCause = causes.find((cause) => !allowsActionApproval({
        policy: input.context.approvalPolicy,
        category: input.requirement!.category,
        cause,
      }));
      if (disallowedCause !== undefined) {
        return Object.freeze({
          ...base,
          status: "denied" as const,
          code: "permission_approval_policy_denied",
          message: `Approval policy does not permit ${disallowedCause}.`,
        });
      }
      return Object.freeze({
        ...base,
        status: "approval_required" as const,
        requirement: input.requirement,
      });
    },

    async consumeActionCoverage(input: ConsumeActionCoverageInput) {
      if (input.interruption.signal.aborted) {
        return Object.freeze({
          status: "interrupted" as const,
          code: "permission_action_coverage_interrupted",
        });
      }
      const coverage = input.context.actionCoverage.find((candidate) =>
        candidate.id === input.coverageId &&
        !consumed.has(candidate.id) &&
        isActionApprovalCoverageApplicable(candidate, {
          runId: candidate.runId,
          actionId: input.subject.ref.action.id,
          actionFingerprint: input.actionFingerprint,
        })
      );
      if (coverage === undefined) {
        return Object.freeze({
          status: "rejected" as const,
          code: "permission_action_coverage_unavailable",
        });
      }
      try {
        if (options.consumeCoverage && !(await options.consumeCoverage(coverage.id))) {
          return Object.freeze({
            status: "rejected" as const,
            code: "permission_action_coverage_conflict",
          });
        }
        consumed.add(coverage.id);
        return Object.freeze({
          status: "consumed" as const,
          recordId: `permission-consumption:${coverage.id}`,
        });
      } catch {
        return Object.freeze({
          status: "failed" as const,
          code: "permission_action_coverage_commit_failed",
        });
      }
    },
  });
}

function authorized(
  base: {
    readonly owner: "permission";
    readonly subject: ActionSubjectRevisionRef;
    readonly recordId: string;
    readonly revision: string;
    readonly assessedAt: string;
  },
  context: ActionPermissionContext,
  actionCoverageId: string | null,
): Extract<ActionPermissionAssessment, { readonly status: "authorized" }> {
  return Object.freeze({
    ...base,
    status: "authorized" as const,
    authorityCoverageDigest: [
      context.authoritySnapshotId,
      actionCoverageId ?? "profile",
      ...context.runGrants.map(({ id }) => id),
      ...context.sessionAuthority.map(({ id }) => id),
    ].join(":"),
    actionCoverageId,
  });
}

function approvalRunId(input: ActionPermissionAssessmentInput): string {
  return input.requirement?.subject.runId ??
    input.context.actionCoverage.find((coverage) =>
      coverage.actionId === input.subject.ref.action.id &&
      coverage.actionFingerprint === input.actionFingerprint
    )?.runId ?? "";
}

function hasApplicableSessionAuthority(input: ActionPermissionAssessmentInput): boolean {
  if (input.requirement === null || input.context.sessionAuthorityContext === null) return false;
  return input.context.sessionAuthority.some((record) => isSessionAuthorityApplicable(record, {
    context: input.context.sessionAuthorityContext!,
    category: input.requirement!.category,
    applicabilityKeys: input.requirement!.subject.applicabilityKeys,
  }));
}

function grantedPermissionSets(context: ActionPermissionContext) {
  return [
    ...context.runGrants.map(({ permissions }) => permissions),
    ...context.sessionAuthority.flatMap(({ grantedPermissions }) =>
      grantedPermissions === null ? [] : [grantedPermissions]
    ),
  ];
}

type EffectAssessment =
  | { readonly status: "authorized" }
  | { readonly status: "missing" }
  | { readonly status: "managed_denial"; readonly code: string; readonly message: string };

function assessEffects(
  effects: readonly CapabilityEffect[],
  profile: ResolvedPermissionProfile,
  grants: ReturnType<typeof grantedPermissionSets>,
): EffectAssessment {
  let missing = false;
  for (const effect of effects) {
    const result = assessEffect(effect, profile, grants);
    if (result.status === "managed_denial") return result;
    if (result.status === "missing") missing = true;
  }
  return missing ? { status: "missing" } : { status: "authorized" };
}

function assessEffect(
  effect: CapabilityEffect,
  profile: ResolvedPermissionProfile,
  grants: ReturnType<typeof grantedPermissionSets>,
): EffectAssessment {
  switch (effect.kind) {
    case "file_system":
      for (const target of effect.targets) {
        const path = target.path.resolvedPath ?? target.path.canonicalPath;
        const managed = profile.fileSystem.managedCeilings.filter((ceiling) =>
          matchesPermissionFileSystemTarget(ceiling.target, path, profile.platform)
        );
        if (managed.some((ceiling) =>
          ceiling.maximumAccess === "none" ||
          (effect.operation === "write" && ceiling.maximumAccess === "read")
        )) {
          return {
            status: "managed_denial",
            code: "permission_managed_filesystem_denied",
            message: "Managed constraints deny the requested filesystem effect.",
          };
        }
        if (!allowsFileSystem(profile, path, effect.operation) &&
          !grants.some((grant) => allowsGrantedPath(grant, path, effect.operation, profile.platform))) {
          return { status: "missing" };
        }
      }
      return { status: "authorized" };
    case "process":
      return profile.process.unrestricted ? { status: "authorized" } : { status: "missing" };
    case "network":
      if (profile.network.enabled) {
        for (const endpoint of effect.endpoints) {
          if (profile.network.deniedDomains.some((pattern) =>
            matchesPermissionDomainPattern(pattern, endpoint.host)
          )) return { status: "missing" };
          const allowed = [...profile.network.profileAllowedDomains, ...profile.network.managedAllowedDomains];
          if (allowed.length > 0 && !allowed.some((pattern) =>
            matchesPermissionDomainPattern(pattern, endpoint.host)
          ) && !grants.some((grant) => allowsGrantedDomain(grant, endpoint.host))) {
            return { status: "missing" };
          }
        }
        return { status: "authorized" };
      }
      return effect.endpoints.every((endpoint) =>
        grants.some((grant) => allowsGrantedDomain(grant, endpoint.host))
      ) ? { status: "authorized" } : { status: "missing" };
    case "remote_tool":
      return { status: "missing" };
  }
}

function allowsFileSystem(
  profile: ResolvedPermissionProfile,
  path: string,
  operation: "read" | "write",
): boolean {
  if (profile.fileSystem.unrestricted) return true;
  const entry = profile.fileSystem.entries.find((candidate) =>
    matchesPermissionFileSystemTarget(candidate.target, path, profile.platform)
  );
  if (entry === undefined || entry.access === "deny") return false;
  return operation === "read" || entry.access === "write";
}

function allowsGrantedPath(
  grant: ReturnType<typeof grantedPermissionSets>[number],
  path: string,
  operation: "read" | "write",
  platform: ResolvedPermissionProfile["platform"],
): boolean {
  const values = operation === "write"
    ? grant.fileSystem?.write ?? []
    : [...(grant.fileSystem?.read ?? []), ...(grant.fileSystem?.write ?? [])];
  return values.some((base) => matchesPermissionFileSystemTarget(
    { kind: "absolute_path", path: base },
    path,
    platform,
  ));
}

function allowsGrantedDomain(
  grant: ReturnType<typeof grantedPermissionSets>[number],
  host: string,
): boolean {
  if (grant.network?.enabled !== true) return false;
  const domains = grant.network.domains ?? [];
  return domains.length === 0 || domains.some((pattern) =>
    matchesPermissionDomainPattern(pattern, host)
  );
}

function uniqueCauses(
  values: readonly ActionPermissionReviewCause[],
): readonly ActionPermissionReviewCause[] {
  return Object.freeze([...new Set(values)]);
}
