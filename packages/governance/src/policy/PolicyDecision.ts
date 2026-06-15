import type { ISODateTimeString, Metadata } from "@agent-anything/shared";

export type PolicyDecisionStatus = "allowed" | "denied" | "requires_review";

export type PolicyDecisionCode =
  | "policy_denied"
  | "policy_workspace_denied"
  | "policy_identity_denied"
  | "policy_quota_denied"
  | "policy_risk_denied"
  | "policy_review_required";

export interface PolicyDecision {
  checkId: string;
  status: PolicyDecisionStatus;
  code?: PolicyDecisionCode;
  reason?: string;
  decidedAt: ISODateTimeString;
  metadata?: Metadata;
}
