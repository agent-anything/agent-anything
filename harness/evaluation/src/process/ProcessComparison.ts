import {snapshotEvaluationData} from "../contract/EvaluationData.js";
import {createEvaluationRecordRef, type EvaluationRecordRef} from "../contract/EvaluationPrimitives.js";
import {createEvaluationGrade, type EvaluationGrade} from "../grading/EvaluationGrading.js";
import {assertProcessBranchIsolation, type EvaluationProcessPlan} from "./ProcessDefinition.js";
import type {ProcessExecutionReport} from "./ProcessExecution.js";

export const processComparisonBoundaries = {
  C01: "before_adoption", C02: "before_method", C03: "before_investment", C04: "task_start",
} as const;
export type ProcessComparisonKind = keyof typeof processComparisonBoundaries;
export type ProcessAssessmentDimension = "preservation" | "subsequent_use" | "timing" | "cost" | "attribution";
export interface ProcessComparisonDefinition {
  readonly ref: EvaluationRecordRef;
  readonly kind: ProcessComparisonKind;
  readonly scope: string;
  readonly hypothesis: string;
  readonly arms: readonly string[];
  readonly repetitions: number;
  readonly order: readonly {readonly arm: string; readonly repetition: number}[];
  readonly environmentProtocol: EvaluationRecordRef;
  readonly stopping: {readonly maxTrials: number; readonly trialTimeoutMs: number; readonly stopOnQuarantine: true};
  readonly exclusions: readonly string[];
  readonly limitations: readonly string[];
}
export interface ProcessComparisonTrial {
  readonly arm: string;
  readonly repetition: number;
  readonly plan: EvaluationProcessPlan;
  readonly report: ProcessExecutionReport;
  readonly grades: readonly EvaluationGrade[];
  readonly measurements: readonly ProcessTrialMeasurement[];
}
export interface ProcessTrialMeasurement {
  readonly name: string;
  readonly role: "target" | "grader" | "environment";
  readonly unit: "ms" | "bytes" | "tokens" | "count" | "currency";
  readonly value: number | null;
  readonly evidence: readonly EvaluationRecordRef[];
  readonly unavailableReason: string | null;
}
export interface ProcessComparisonReport {
  readonly version: "1";
  readonly definition: ProcessComparisonDefinition;
  readonly trials: readonly ProcessComparisonTrial[];
  readonly status: "complete" | "partial";
  readonly missingTrials: readonly {readonly arm: string; readonly repetition: number}[];
  readonly limitations: readonly string[];
}

export function createProcessComparison(input: ProcessComparisonDefinition): ProcessComparisonDefinition {
  const value = snapshotEvaluationData(input) as unknown as ProcessComparisonDefinition;
  createEvaluationRecordRef(value.ref); createEvaluationRecordRef(value.environmentProtocol);
  if (!Object.hasOwn(processComparisonBoundaries, value.kind) || !value.scope.trim() || !value.hypothesis.trim()) throw new TypeError("Comparison requires kind, scope and hypothesis");
  if (value.arms.length < 2 || new Set(value.arms).size !== value.arms.length || value.arms.some(arm => !arm.trim())) throw new TypeError("Comparison requires distinct declared arms");
  if (!Number.isSafeInteger(value.repetitions) || value.repetitions < 1 || value.repetitions > 100) throw new TypeError("Invalid repetition budget");
  if (value.stopping.stopOnQuarantine !== true || !Number.isSafeInteger(value.stopping.trialTimeoutMs) || value.stopping.trialTimeoutMs < 1 ||
      value.stopping.maxTrials !== value.arms.length * value.repetitions) throw new TypeError("Comparison budget must match fixed repetitions");
  const keys = new Set(value.order.map(entry => `${entry.arm}:${entry.repetition}`));
  if (keys.size !== value.stopping.maxTrials || value.order.length !== keys.size || value.arms.some(arm => Array.from({length: value.repetitions}, (_, i) => i + 1).some(n => !keys.has(`${arm}:${n}`)))) throw new TypeError("Incomplete or duplicate fixed order");
  return value;
}

export function assembleProcessComparison(definition: ProcessComparisonDefinition, trials: readonly ProcessComparisonTrial[]): ProcessComparisonReport {
  definition = createProcessComparison(definition);
  assertProcessBranchIsolation(trials.map(trial => trial.plan.branch));
  const seen = new Set<string>();
  let previousOrder = -1;
  for (const trial of trials) {
    const key = `${trial.arm}:${trial.repetition}`;
    const order = definition.order.findIndex(entry => entry.arm === trial.arm && entry.repetition === trial.repetition);
    if (seen.has(key) || order <= previousOrder) throw new TypeError("Unexpected comparison Trial order");
    previousOrder = order;
    seen.add(key);
    if (trial.plan.startingState.boundary !== processComparisonBoundaries[definition.kind]) throw new TypeError("Comparison starting boundary mismatch");
    if (trial.plan.trial.ref.id !== trial.report.trialRef.id || trial.plan.trial.ref.revision !== trial.report.trialRef.revision) throw new TypeError("Comparison report belongs to another Trial");
    if (trial.plan.trial.repetitionOrdinal !== trial.repetition || trial.plan.trial.environmentProtocolRef.id !== definition.environmentProtocol.id ||
        trial.plan.trial.environmentProtocolRef.revision !== definition.environmentProtocol.revision) throw new TypeError("Comparison environment or repetition mismatch");
    for (const grade of trial.grades) {
      createEvaluationGrade(grade);
      if (!trial.report.capture || grade.captureRef.id !== trial.report.capture.ref.id || grade.captureRef.revision !== trial.report.capture.ref.revision) throw new TypeError("Grade must bind this Trial capture");
    }
    for (const measurement of trial.measurements) {
      if (!measurement.name.trim() || !["target", "grader", "environment"].includes(measurement.role) ||
          !["ms", "bytes", "tokens", "count", "currency"].includes(measurement.unit) ||
          (measurement.value === null ? !measurement.unavailableReason : !Number.isFinite(measurement.value) || measurement.value < 0 || measurement.evidence.length === 0 || measurement.unavailableReason !== null)) throw new TypeError("Measurement needs a finite value with evidence, or an explicit unknown");
      measurement.evidence.forEach(ref => createEvaluationRecordRef(ref));
    }
  }
  const missingTrials = definition.order.filter(entry => !seen.has(`${entry.arm}:${entry.repetition}`));
  return snapshotEvaluationData({version: "1", definition, trials, status: missingTrials.length ? "partial" : "complete", missingTrials,
    limitations: [...definition.limitations, ...(definition.repetitions < 3 ? ["small_sample_no_general_advantage_claim"] : []),
      ...trials.flatMap(trial => trial.report.limitations)]}) as unknown as ProcessComparisonReport;
}

export function processEvidenceGrade(input: {
  ref: EvaluationRecordRef; captureRef: EvaluationRecordRef; criterionRef: EvaluationRecordRef; graderRef: EvaluationRecordRef;
  dimension: ProcessAssessmentDimension; verdict: "conforms" | "violated" | "insufficient_evidence" | "not_applicable";
  evidence: readonly EvaluationRecordRef[]; rationale: string; gradedAt: string; method: "deterministic" | "human_input" | "hosted_model";
  modelRef?: EvaluationRecordRef | null;
  captureSlotIds: readonly string[];
}): EvaluationGrade {
  if ((input.verdict === "conforms" || input.verdict === "violated") && !input.evidence.length) throw new TypeError("A factual grade requires independent evidence");
  if (input.method === "hosted_model" && !input.modelRef) throw new TypeError("Model grading requires explicit model attribution");
  return createEvaluationGrade({ref: input.ref, captureRef: input.captureRef, criterionRef: input.criterionRef, graderRef: input.graderRef,
    value: {kind: "categorical", value: input.verdict, categories: ["conforms", "violated", "insufficient_evidence", "not_applicable"]},
    criterionOutcome: input.verdict === "conforms" ? "satisfied" : input.verdict === "violated" ? "not_satisfied" : "indeterminate",
    evidenceRefs: input.evidence, captureSlotIds: input.captureSlotIds, rationale: input.rationale,
    uncertainty: {status: "unavailable", reason: "Single process judgement is not a confidence estimate"},
    attribution: {method: input.method, actorRef: input.graderRef, modelRef: input.modelRef ?? null, metadata: {dimension: input.dimension}},
    disagreementGroup: input.criterionRef.id, gradedAt: input.gradedAt, limitations: []});
}
