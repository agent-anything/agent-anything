export type QualificationOutcome = "qualified" | "not_qualified" | "inconclusive";
export interface QualificationScopeResult {
  readonly scope: string;
  readonly outcome: QualificationOutcome;
  readonly passed: number;
  readonly total: number;
  readonly required: number;
}
export interface QualificationCampaignSummary {
  readonly id: string;
  readonly model: string;
  readonly startedAt: string;
  readonly status: "running" | "completed" | "cancelled" | "interrupted";
  readonly currentCase: string | null;
  readonly completedTrials: number;
  readonly totalTrials: number;
  readonly currentTarget: boolean;
  readonly publishedAt: string | null;
  readonly results: readonly QualificationScopeResult[];
  readonly trials: readonly { readonly id: string; readonly title: string; readonly repetition: number;
    readonly outcome: "passed" | "failed" | "inconclusive"; readonly reason: string;
    readonly stage: "operation_request" | "final_response";
    readonly failureCategory: "protocol" | "case_requirement" | "infrastructure" | null;
    readonly resultDelivery: "not_applicable" | "not_submitted" | "submitted" }[];
}
export interface HelarcQualificationSnapshot {
  readonly available: boolean;
  readonly error: string | null;
  readonly targetId: string | null;
  readonly model: string | null;
  readonly disposition: string | null;
  readonly scopes: readonly { readonly scope: string; readonly applicability: string; readonly outcome: QualificationOutcome | null }[];
  readonly activeCampaignId: string | null;
  readonly campaigns: readonly QualificationCampaignSummary[];
  readonly protocol: { readonly revision: string; readonly totalTrials: number; readonly maximumRequests: number;
    readonly requestTimeoutMs: number; readonly limitations: readonly string[] };
}
export type HelarcQualificationCommandResult = { readonly ok: true } | { readonly ok: false; readonly error: string };
export type HelarcQualificationEvidence = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };
