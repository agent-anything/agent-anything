import { canonicalEncode } from "@agent-anything/canonical-action/subject";
import type { ApprovalReviewerBinding, ResolvedRunPermissionConfig } from "../run/RunPermissionConfig.js";
import type { RunConfig } from "./RunConfig.js";

type ReviewerDefinition = Exclude<ApprovalReviewerBinding, {kind: "auto_review"}> |
  Omit<Extract<ApprovalReviewerBinding, {kind: "auto_review"}>, "reviewer">;

export type RetainedRunConfig = Omit<RunConfig, "permissions"> & {
  readonly permissions: Omit<ResolvedRunPermissionConfig, "reviewer" | "sessionAuthority" | "persistentPolicyAmendments"> & {
    readonly reviewer: ReviewerDefinition | null;
    readonly sessionAuthority: Omit<NonNullable<ResolvedRunPermissionConfig["sessionAuthority"]>, "port"> | null;
    readonly persistentPolicyAmendments: boolean;
  };
};

/** Retain configuration data, never inspect or serialize executable services. */
export function retainRunConfiguration(config: RunConfig): RetainedRunConfig {
  const {reviewer, sessionAuthority, persistentPolicyAmendments, ...policy} = config.permissions;
  const reviewerDefinition = reviewer?.kind === "auto_review"
    ? {kind: reviewer.kind, bindingId: reviewer.bindingId, descriptor: reviewer.descriptor, reviewTimeoutMs: reviewer.reviewTimeoutMs}
    : reviewer;
  return structuredClone({...config, permissions: {...policy, reviewer: reviewerDefinition,
    sessionAuthority: sessionAuthority === null ? null : {context: sessionAuthority.context, initialRecords: sessionAuthority.initialRecords},
    persistentPolicyAmendments: persistentPolicyAmendments !== null}});
}

/** The trusted composition rebinds services only after matching the retained definition. */
export function restoreRunConfiguration(saved: RetainedRunConfig, trusted: RunConfig): RunConfig {
  const expected = canonicalEncode("run-configuration.v1", saved);
  const actual = canonicalEncode("run-configuration.v1", retainRunConfiguration(trusted));
  if (expected.length !== actual.length || expected.some((value, index) => actual[index] !== value)) {
    throw new TypeError("Retained Run configuration bindings are unavailable.");
  }
  return {...structuredClone(saved), permissions: {...structuredClone(saved.permissions),
    reviewer: trusted.permissions.reviewer,
    sessionAuthority: saved.permissions.sessionAuthority === null ? null : {
      ...structuredClone(saved.permissions.sessionAuthority), port: trusted.permissions.sessionAuthority!.port},
    persistentPolicyAmendments: trusted.permissions.persistentPolicyAmendments}};
}
