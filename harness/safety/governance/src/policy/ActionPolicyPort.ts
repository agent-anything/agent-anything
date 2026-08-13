import type {
  ActionSubjectRevisionRef,
  CanonicalActionSubjectRevision,
} from "@agent-anything/canonical-action/subject";

export interface ActionPolicyContext {
  readonly policySnapshotId: string;
  readonly workspaceTrustState: "trusted" | "restricted" | "unknown" | null;
  readonly identityId: string | null;
  readonly environmentId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ActionPolicyCheckInput {
  readonly checkId: string;
  readonly subject: CanonicalActionSubjectRevision;
  readonly context: ActionPolicyContext;
}

export type ActionPolicyAssessment =
  | {
      readonly status: "allowed" | "review_required" | "denied";
      readonly owner: "governance";
      readonly subject: ActionSubjectRevisionRef;
      readonly checkId: string;
      readonly recordId: string;
      readonly revision: string;
      readonly code: string | null;
      readonly reason: string | null;
      readonly decidedAt: string;
    }
  | {
      readonly status: "failed" | "interrupted";
      readonly owner: "governance";
      readonly subject: ActionSubjectRevisionRef;
      readonly checkId: string;
      readonly code: string;
      readonly message: string;
      readonly decidedAt: string;
    };

export interface ActionPolicyPort {
  evaluate(input: ActionPolicyCheckInput): Promise<ActionPolicyAssessment>;
}

export function createAllowAllActionPolicyPort(
  now: () => string = () => new Date().toISOString(),
): ActionPolicyPort {
  return Object.freeze({
    async evaluate(input: ActionPolicyCheckInput): Promise<ActionPolicyAssessment> {
      const decidedAt = now();
      return Object.freeze({
        status: "allowed" as const,
        owner: "governance" as const,
        subject: input.subject.ref,
        checkId: input.checkId,
        recordId: `policy:${input.checkId}`,
        revision: input.context.policySnapshotId,
        code: null,
        reason: null,
        decidedAt,
      });
    },
  });
}
