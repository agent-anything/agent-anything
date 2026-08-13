import type { ActionSubjectRevisionRef } from "../subject/index.js";

export interface AttributedAssessmentRef {
  readonly owner: string;
  readonly recordId: string;
  readonly revision: string;
}

export type ActionAssessmentStatus =
  | "ready"
  | "approval_required"
  | "denied"
  | "invalidated"
  | "failed"
  | "interrupted";

export interface ActionAssessmentRecord {
  readonly id: string;
  readonly subject: ActionSubjectRevisionRef;
  readonly status: ActionAssessmentStatus;
  readonly policy: AttributedAssessmentRef;
  readonly permission: AttributedAssessmentRef;
  readonly approval: AttributedAssessmentRef | null;
  readonly revalidation: AttributedAssessmentRef | null;
  readonly authorityCoverageDigest: string | null;
  readonly assessedAt: string;
}

export interface ActionRevalidationResult {
  readonly subject: ActionSubjectRevisionRef;
  readonly status: "valid" | "invalidated" | "failed" | "interrupted";
  readonly owner: string;
  readonly code: string | null;
  readonly recordId: string;
}
