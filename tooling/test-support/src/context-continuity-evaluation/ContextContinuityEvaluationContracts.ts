import type { EvaluationCapture } from "@agent-anything/evaluation/capture";
import type { EvaluationGrade } from "@agent-anything/evaluation/grading";
import type {
  EvaluationMetric,
  EvaluationMetricGateOutcome,
} from "@agent-anything/evaluation/metrics";
import type { EvaluationLimitation, EvaluationRecordRef } from "@agent-anything/evaluation/definition";

export const CONTEXT_CONTINUITY_EVALUATION_REVISION =
  "context-continuity-evaluation-v1";

export type ContextContinuityFixtureId =
  | "complete_information"
  | "required_information_missing"
  | "disclosure_rejected"
  | "policy_rejected"
  | "optional_budget_omission"
  | "mandatory_complete_input_overflow"
  | "conflicting_current_replacements"
  | "stale_transition"
  | "cancelled_transition"
  | "instruction_like_payload"
  | "continuation_reuse"
  | "continuation_incompatibility_reset"
  | "continuation_provider_rejection"
  | "continuation_loss_reconstruction"
  | "continuation_compaction"
  | "provider_continuation_unsupported"
  | "model_reasoning_failure";

export type ContextContinuityFailureAttribution =
  | "none"
  | "missing_contribution"
  | "admission_rejection"
  | "context_transition"
  | "run_control"
  | "projection_omission"
  | "model_reasoning"
  | "tool_availability"
  | "tool_exposure"
  | "provider_transport"
  | "execution"
  | "verification";

export type ContextContinuityDownstreamOutcome =
  | "succeeded"
  | "failed"
  | "not_exercised";

export interface ContextContinuityFixtureDefinition {
  readonly id: ContextContinuityFixtureId;
  readonly title: string;
  readonly expectedAttribution: ContextContinuityFailureAttribution;
  readonly expectedDownstreamOutcome: ContextContinuityDownstreamOutcome;
  readonly deterministicLatencyMs: number;
}

export interface ContextContinuityDispositionCounts {
  readonly included: number;
  readonly transformed: number;
  readonly referenced: number;
  readonly omitted: number;
  readonly rejected: number;
  readonly blocked: number;
}

export interface ContextContinuityProjectionEvidence {
  readonly outcome: "projected" | "blocked";
  readonly code: string | null;
  readonly consideredItemCount: number;
  readonly projectedItemCount: number;
  readonly projectedAmount: number;
  readonly budgetMaximum: number;
  readonly dispositionCounts: ContextContinuityDispositionCounts;
  readonly complete: boolean;
}

export interface ContextContinuityModelInputEvidence {
  readonly limitAmount: number;
  readonly inputAmount: number;
  readonly outputReserveAmount: number;
  readonly remainingAmount: number;
  readonly budgetError: number;
}

export interface ContextContinuityContinuationEvidence {
  readonly outcome: string;
  readonly reason: string | null;
  readonly reconstructionEquivalent: boolean | null;
  readonly compactionObserved: boolean;
  readonly behaviorCorrect: boolean;
  readonly providerSupport: "supported" | "unsupported" | "not_applicable";
}

export interface ContextContinuitySafeTrajectory {
  readonly fixtureId: ContextContinuityFixtureId;
  readonly fixtureRevision: string;
  readonly targetRevision: string;
  readonly environmentRevision: string;
  readonly providerRevision: string;
  readonly modelRevision: string;
  readonly policyRevision: string;
  readonly profileRevision: string;
  readonly estimatorRevision: string;
  readonly protocolRevision: string;
  readonly toolExposureRevision: string;
  readonly contributionSuppliedCount: number;
  readonly contributionAdmittedCount: number;
  readonly transitionAttemptedCount: number;
  readonly transitionCommittedCount: number;
  readonly transitionConflictCount: number;
  readonly transitionCancelledCount: number;
  readonly projection: ContextContinuityProjectionEvidence | null;
  readonly modelInput: ContextContinuityModelInputEvidence | null;
  readonly continuation: ContextContinuityContinuationEvidence | null;
  readonly attribution: ContextContinuityFailureAttribution;
  readonly attributionCorrect: boolean;
  readonly failureCode: string | null;
  readonly disclosureCorrect: boolean;
  readonly leakageDetected: boolean;
  readonly latencyMs: number;
  readonly downstreamOutcome: ContextContinuityDownstreamOutcome;
  readonly limitations: readonly string[];
}

export interface ContextContinuityEvaluationTargetDeclaration {
  readonly ref: EvaluationRecordRef;
  readonly environmentRevision: string;
  readonly providerRevision: string;
  readonly modelRevision: string;
  readonly estimatorRevision: string;
  readonly policyRevision: string;
  readonly protocolRevision: string;
  readonly toolExposureRevision: string;
}

export interface ContextContinuityEvaluationCandidate {
  readonly schemaVersion: 1;
  readonly kind: "context_continuity_evaluation_candidate";
  readonly revision: string;
  readonly target: ContextContinuityEvaluationTargetDeclaration;
  readonly fixtures: readonly ContextContinuitySafeTrajectory[];
  readonly captures: readonly EvaluationCapture[];
  readonly grades: readonly EvaluationGrade[];
  readonly metrics: readonly EvaluationMetric[];
  readonly gateOutcomes: readonly EvaluationMetricGateOutcome[];
  readonly exclusions: readonly {
    readonly metricRef: EvaluationRecordRef;
    readonly trialRef: EvaluationRecordRef | null;
    readonly code: string;
    readonly message: string;
  }[];
  readonly uncertainty: "retained_per_metric";
  readonly limitations: readonly EvaluationLimitation[];
}
