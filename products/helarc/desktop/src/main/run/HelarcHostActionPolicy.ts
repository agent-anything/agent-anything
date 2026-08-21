import type {
  ActionPolicyAssessment,
  ActionPolicyCheckInput,
  ActionPolicyPort,
} from "@agent-anything/governance/policy";
import type { HelarcPermissionPreset } from "@agent-anything/helarc/configuration";

export function createHelarcHostActionPolicy(input: {
  readonly permissionPreset: HelarcPermissionPreset;
  readonly now?: () => string;
}): ActionPolicyPort {
  const now = input.now ?? (() => new Date().toISOString());
  return Object.freeze({
    async evaluate(check: ActionPolicyCheckInput): Promise<ActionPolicyAssessment> {
      const reviewRequired = input.permissionPreset !== "full_access" &&
        check.subject.effects.some((effect) =>
          effect.kind === "file_system" && effect.operation === "write"
        );
      return Object.freeze({
        status: reviewRequired ? "review_required" as const : "allowed" as const,
        owner: "governance" as const,
        subject: check.subject.ref,
        checkId: check.checkId,
        recordId: `policy:${check.checkId}`,
        revision: check.context.policySnapshotId,
        code: reviewRequired ? "helarc_file_write_review_required" : null,
        reason: reviewRequired
          ? "The active Host policy requires review for this file write."
          : null,
        decidedAt: now(),
      });
    },
  });
}
