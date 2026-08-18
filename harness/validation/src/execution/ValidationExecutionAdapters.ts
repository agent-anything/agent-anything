import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type {
  ValidationAssessment,
  ValidationAssessmentVerdict,
} from "../assessment/index.js";
import type {
  ValidationAssessmentMethodRef,
  ValidationOwnerRef,
  ValidationRequirement,
} from "../definition/index.js";
import type { ValidationEvidence } from "../evidence/index.js";
import type { ValidationEvidenceCoverage } from "../evidence/index.js";
import type {
  ValidationSubjectAdapter,
  ValidationSubjectAdapterRef,
  ValidationSubjectFreshnessPort,
  ValidationSubjectSnapshot,
} from "../subject/index.js";
import type {
  CheckAttempt,
  CheckDefinition,
  CheckFindingInput,
  ValidationCheckInterpretation,
  ValidationLowerCheckSettlement,
} from "./ValidationExecution.js";

export type ValidationGeneratedRecordKind =
  | "check_attempt"
  | "check_result"
  | "check_finding"
  | "validation_evidence"
  | "validation_assessment";

export interface ValidationClockPort {
  now(): string;
}

export interface ValidationIdentityPort {
  nextId(kind: ValidationGeneratedRecordKind): string;
}

export interface ValidationSubjectAdapterResolverPort {
  resolve(ref: ValidationSubjectAdapterRef): ValidationSubjectAdapter | null;
}

export interface ValidationSubjectFreshnessResolverPort {
  resolve(snapshot: ValidationSubjectSnapshot): ValidationSubjectFreshnessPort | null;
}

export interface ValidationPureCheckInput {
  readonly requirement: ValidationRequirement;
  readonly subject: ValidationSubjectSnapshot;
  readonly definition: CheckDefinition;
  readonly attempt: CheckAttempt;
}

export interface ValidationPureCheckEvaluatorPort {
  evaluate(
    input: ValidationPureCheckInput,
    interruption: InvocationInterruptionContext,
  ): Promise<ValidationCheckInterpretation>;
}

export interface ValidationPureCheckResolverPort {
  resolve(ref: ValidationOwnerRef): ValidationPureCheckEvaluatorPort | null;
}

export interface ValidationOperationCheckInput extends ValidationPureCheckInput {}

export interface ValidationOperationCheckPort {
  requestSettlement(
    input: ValidationOperationCheckInput,
    interruption: InvocationInterruptionContext,
  ): Promise<ValidationLowerCheckSettlement>;
}

export interface ValidationOperationCheckResolverPort {
  resolve(definition: CheckDefinition): ValidationOperationCheckPort | null;
}

export interface ValidationCheckInterpretationInput extends ValidationPureCheckInput {
  readonly settlement: ValidationLowerCheckSettlement;
}

export interface ValidationCheckInterpreterPort {
  interpret(
    input: ValidationCheckInterpretationInput,
    interruption: InvocationInterruptionContext,
  ): Promise<ValidationCheckInterpretation>;
}

export interface ValidationCheckInterpreterResolverPort {
  resolve(ref: ValidationOwnerRef): ValidationCheckInterpreterPort | null;
}

export interface ValidationAssessmentMethodInput {
  readonly requirement: ValidationRequirement;
  readonly subject: ValidationSubjectSnapshot;
  readonly evidence: readonly ValidationEvidence[];
}

export interface ValidationAssessmentDraft {
  readonly verdict: ValidationAssessmentVerdict;
  readonly basis: string;
  readonly coverage: ValidationEvidenceCoverage;
  readonly limitations: readonly string[];
}

export interface ValidationAssessmentMethodPort {
  assess(
    input: ValidationAssessmentMethodInput,
    interruption: InvocationInterruptionContext,
  ): Promise<ValidationAssessmentDraft>;
}

export interface ValidationAssessmentMethodResolverPort {
  resolve(ref: ValidationAssessmentMethodRef): ValidationAssessmentMethodPort | null;
}

export interface ValidationCheckFindingFactoryInput extends CheckFindingInput {
  readonly resultId: string;
  readonly index: number;
}

export interface ValidationAssessmentCommitResult {
  readonly assessment: ValidationAssessment;
  readonly currentRevision: number;
}
