import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type {
  VerificationAssessment,
  VerificationAssessmentVerdict,
} from "../assessment/index.js";
import type {
  VerificationAssessmentMethodRef,
  VerificationOwnerRef,
  VerificationRequirement,
} from "../definition/index.js";
import type { VerificationEvidence } from "../evidence/index.js";
import type { VerificationEvidenceCoverage } from "../evidence/index.js";
import type {
  VerificationSubjectAdapter,
  VerificationSubjectAdapterRef,
  VerificationSubjectFreshnessPort,
  VerificationSubjectSnapshot,
} from "../subject/index.js";
import type {
  CheckAttempt,
  CheckDefinition,
  CheckFindingInput,
  CheckResult,
  VerificationCheckInterpretation,
  VerificationLowerCheckSettlement,
} from "./VerificationExecution.js";

export type VerificationGeneratedRecordKind =
  | "check_attempt"
  | "check_result"
  | "check_finding"
  | "verification_evidence"
  | "verification_assessment";

export interface VerificationClockPort {
  now(): string;
}

export interface VerificationIdentityPort {
  nextId(kind: VerificationGeneratedRecordKind): string;
}

export interface VerificationSubjectAdapterResolverPort {
  resolve(ref: VerificationSubjectAdapterRef): VerificationSubjectAdapter | null;
}

export interface VerificationSubjectFreshnessResolverPort {
  resolve(snapshot: VerificationSubjectSnapshot): VerificationSubjectFreshnessPort | null;
}

export interface VerificationPureCheckInput {
  readonly requirement: VerificationRequirement;
  readonly subject: VerificationSubjectSnapshot;
  readonly definition: CheckDefinition;
  readonly attempt: CheckAttempt;
}

export interface VerificationPureCheckEvaluatorPort {
  evaluate(
    input: VerificationPureCheckInput,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationCheckInterpretation>;
}

export interface VerificationPureCheckResolverPort {
  resolve(ref: VerificationOwnerRef): VerificationPureCheckEvaluatorPort | null;
}

export interface VerificationOperationCheckInput extends VerificationPureCheckInput {}

export interface VerificationOperationCheckPort {
  requestSettlement(
    input: VerificationOperationCheckInput,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationLowerCheckSettlement>;
}

export interface VerificationOperationCheckResolverPort {
  resolve(definition: CheckDefinition): VerificationOperationCheckPort | null;
}

export interface VerificationCheckInterpretationInput extends VerificationPureCheckInput {
  readonly settlement: VerificationLowerCheckSettlement;
}

export interface VerificationCheckInterpreterPort {
  interpret(
    input: VerificationCheckInterpretationInput,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationCheckInterpretation>;
}

export interface VerificationCheckInterpreterResolverPort {
  resolve(ref: VerificationOwnerRef): VerificationCheckInterpreterPort | null;
}

export interface VerificationAssessmentMethodInput {
  readonly requirement: VerificationRequirement;
  readonly subject: VerificationSubjectSnapshot;
  readonly evidence: readonly VerificationAssessmentEvidence[];
}

export interface VerificationAssessmentEvidence {
  readonly evidence: VerificationEvidence;
  readonly source:
    | { readonly kind: "check_result"; readonly result: CheckResult }
    | { readonly kind: "context_evidence"; readonly evidenceRef: string }
    | { readonly kind: "owner_record"; readonly record: VerificationOwnerRef };
}

export interface VerificationAssessmentDraft {
  readonly verdict: VerificationAssessmentVerdict;
  readonly basis: string;
  readonly coverage: VerificationEvidenceCoverage;
  readonly limitations: readonly string[];
}

export interface VerificationAssessmentMethodPort {
  assess(
    input: VerificationAssessmentMethodInput,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationAssessmentDraft>;
}

export interface VerificationAssessmentMethodResolverPort {
  resolve(ref: VerificationAssessmentMethodRef): VerificationAssessmentMethodPort | null;
}

export interface VerificationCheckFindingFactoryInput extends CheckFindingInput {
  readonly resultId: string;
  readonly index: number;
}

export interface VerificationAssessmentCommitResult {
  readonly assessment: VerificationAssessment;
  readonly currentRevision: number;
}
