import { createHash } from "node:crypto";
import {
  EvaluationCampaignExecution,
  type EvaluationCampaignAggregationPort,
  type EvaluationCampaignAggregationResult,
  type EvaluationCampaignSnapshot,
} from "@agent-anything/evaluation/campaign";
import type {
  EvaluationCapture,
} from "@agent-anything/evaluation/capture";
import type {
  EvaluationDataValue,
  EvaluationRecordRef,
} from "@agent-anything/evaluation/definition";
import {
  DeterministicEvaluationGrader,
  EvaluationGradingExecution,
  ReferenceEvaluationGrader,
  type EvaluationCriterion,
  type EvaluationGrade,
  type EvaluationGradeCandidate,
  type EvaluationGraderDefinition,
} from "@agent-anything/evaluation/grading";
import {
  aggregateEvaluationMetric,
  comparePairedEvaluationSamples,
  evaluateEvaluationMetricGate,
  type EvaluationMetric,
  type EvaluationMetricDefinition,
  type EvaluationMetricInput,
  type EvaluationMetricSample,
  type EvaluationMetricTrialStatus,
  type EvaluationPairedComparison,
} from "@agent-anything/evaluation/metrics";
import type {
  EvaluationAppendResult,
  EvaluationExpectedRevisionStore,
  EvaluationImmutableRecordStore,
  EvaluationStoreResult,
  EvaluationVersionedSnapshot,
} from "@agent-anything/evaluation/persistence";
import {
  createEvaluationBaselineAcceptance,
  createEvaluationReport,
  projectEvaluationReportForPublication,
  type EvaluationBaselineAcceptance,
  type EvaluationReport,
  type EvaluationReportPublicationProjection,
} from "@agent-anything/evaluation/report";
import {
  EvaluationTrialExecution,
  type EvaluationDeadlinePort,
  type EvaluationTargetObservation,
  type EvaluationTrial,
  type EvaluationTrialSnapshot,
} from "@agent-anything/evaluation/trial";
import {
  HELARC_EVALUATION_CORPUS_REVISION,
  HELARC_EVALUATION_TIME,
  createHelarcEvaluationCorpus,
  type HelarcEvaluationCorpus,
  type HelarcEvaluationExpectedClaim,
} from "./HelarcEvaluationCorpus.js";
import { createHelarcEvaluationTargetAdapter } from "./HelarcEvaluationTarget.js";

const BASELINE_LIMITATION = Object.freeze({
  code: "deterministic_system_baseline_only",
  message: "This artifact is a deterministic system baseline and is not evidence of general model intelligence.",
  metadata: Object.freeze({}),
});

export interface HelarcEvaluationCaseResult {
  readonly caseRef: EvaluationRecordRef;
  readonly repetitionOrdinal: number;
  readonly trialStatus: EvaluationTrialSnapshot["status"];
  readonly targetOutcomeStatus: EvaluationTargetObservation["outcome"]["status"];
  readonly captureStatus: EvaluationCapture["status"];
  readonly outcomeGradePassed: boolean;
  readonly safetyGradePassed: boolean;
  readonly traceIssueCodes: readonly string[];
  readonly semanticDigest: string;
}

export interface HelarcEvaluationBaselineArtifact {
  readonly schemaVersion: 1;
  readonly kind: "helarc_deterministic_system_baseline";
  readonly corpusRevision: string;
  readonly targetSnapshotRef: EvaluationRecordRef;
  readonly targetManifestDigest: string;
  readonly campaignRef: EvaluationRecordRef;
  readonly report: EvaluationReport;
  readonly publication: EvaluationReportPublicationProjection;
  readonly acceptance: EvaluationBaselineAcceptance;
  readonly metrics: readonly EvaluationMetric[];
  readonly cases: readonly HelarcEvaluationCaseResult[];
  readonly limitations: readonly typeof BASELINE_LIMITATION[];
}

export interface HelarcEvaluationBaselineMetricSignature {
  readonly ref: EvaluationRecordRef;
  readonly definitionRef: EvaluationRecordRef;
  readonly targetSnapshotRef: EvaluationRecordRef;
  readonly samples: readonly HelarcEvaluationBaselineSampleSignature[];
  readonly distribution: EvaluationMetric["distribution"];
  readonly uncertainty: EvaluationMetric["uncertainty"];
  readonly exclusions: EvaluationMetric["exclusions"];
  readonly limitations: EvaluationMetric["limitations"];
}

export interface HelarcEvaluationBaselineSampleSignature {
  readonly caseRef: EvaluationRecordRef;
  readonly pairingKey: string;
  readonly value: boolean | number;
}

export interface HelarcEvaluationBaselineSignature {
  readonly schemaVersion: 1;
  readonly kind: "helarc_deterministic_system_baseline_signature";
  readonly corpusRevision: string;
  readonly targetSnapshotRef: EvaluationRecordRef;
  readonly targetManifestDigest: string;
  readonly campaignRef: EvaluationRecordRef;
  readonly reportRef: EvaluationRecordRef;
  readonly acceptanceRef: EvaluationRecordRef;
  readonly publication: EvaluationReportPublicationProjection;
  readonly metrics: readonly HelarcEvaluationBaselineMetricSignature[];
  readonly cases: readonly HelarcEvaluationCaseResult[];
  readonly limitations: readonly typeof BASELINE_LIMITATION[];
}

export type HelarcEvaluationBaselineComparable =
  | HelarcEvaluationBaselineArtifact
  | HelarcEvaluationBaselineSignature;

export type HelarcEvaluationBaselineComparison =
  | {
      readonly status: "equivalent";
      readonly pairedComparisons: readonly EvaluationPairedComparison[];
    }
  | {
      readonly status: "regressed";
      readonly differences: readonly string[];
      readonly pairedComparisons: readonly EvaluationPairedComparison[];
    }
  | {
      readonly status: "incomparable";
      readonly differences: readonly string[];
      readonly pairedComparisons: readonly [];
    };

interface HelarcEvaluationAggregation {
  readonly artifact: HelarcEvaluationBaselineArtifact;
}

export async function runHelarcEvaluationBaselineCandidate(): Promise<HelarcEvaluationBaselineArtifact> {
  const corpus = createHelarcEvaluationCorpus();
  const targetAdapter = createHelarcEvaluationTargetAdapter(corpus);
  const campaignState = new MemorySnapshotStore<EvaluationCampaignSnapshot>();
  const trialStates = new MemorySnapshotStore<EvaluationTrialSnapshot>();
  const trialRecords = new MemoryRecordStore<EvaluationTrial>();
  const observations = new MemoryRecordStore<EvaluationTargetObservation>(recordRef);
  const captures = new MemoryRecordStore<EvaluationCapture>(recordRef);
  const grades = new MemoryRecordStore<EvaluationGrade>(recordRef);
  const deadline = new DeterministicEvaluationDeadline();
  const clock = Object.freeze({ now: () => HELARC_EVALUATION_TIME });
  let aggregation: HelarcEvaluationAggregation | null = null;
  let aggregationError: unknown = null;
  const aggregationPort: EvaluationCampaignAggregationPort = Object.freeze({
    async aggregate(
      input: Parameters<EvaluationCampaignAggregationPort["aggregate"]>[0],
    ) {
      try {
        const result = await aggregateHelarcCampaign({
          corpus,
          trials: input.trials,
          captures,
          observations,
          grades,
          deadline,
          signal: input.signal,
          deadlineAt: input.deadlineAt,
        });
        aggregation = result;
        return Object.freeze({
          status: "aggregated" as const,
          gradeRefs: result.artifact.report.gradeRefs,
          metricRefs: result.artifact.report.metricRefs,
          reportRefs: Object.freeze([result.artifact.report.ref]),
          failures: Object.freeze([]),
        });
      } catch (error) {
        aggregationError = error;
        throw error;
      }
    },
  });
  const execution = new EvaluationCampaignExecution(corpus.campaign, {
    stateStore: campaignState,
    trialStore: trialRecords,
    trialIdentity: {
      createTrialRef(input) {
        return Object.freeze({
          id: `${input.caseRef.id}.rep-${input.repetitionOrdinal}.trial`,
          revision: input.targetSnapshotRef.revision,
        });
      },
    },
    createTrialExecution(trial) {
      return new EvaluationTrialExecution(trial, {
        environment: targetAdapter.environment,
        target: targetAdapter.target,
        capture: targetAdapter.capture,
        capturePolicy: corpus.capturePolicy,
        captureIdentity: {
          createCaptureRef(input) {
            return Object.freeze({
              id: `${input.trialRef.id}.capture`,
              revision: input.trialRef.revision,
            });
          },
        },
        stateStore: trialStates,
        targetObservationStore: observations,
        captureStore: captures,
        clock,
        deadline,
      });
    },
    aggregation: aggregationPort,
    clock,
    deadline,
  });
  const controller = new AbortController();
  const snapshot = await execution.run({ signal: controller.signal, deadlineAt: null });
  const completedAggregation = aggregation as HelarcEvaluationAggregation | null;
  if (snapshot.status !== "completed" || completedAggregation === null) {
    const detail = aggregationError instanceof Error
      ? ` Aggregation failed: ${aggregationError.message}`
      : ` Trial statuses: ${trialStates.values.map((item) => item.status).join(", ")}.`;
    throw new Error(`Helarc Evaluation Campaign settled as '${snapshot.status}'.${detail}`);
  }
  return completedAggregation.artifact;
}

export function compareHelarcEvaluationBaseline(
  acceptedInput: HelarcEvaluationBaselineComparable,
  candidateInput: HelarcEvaluationBaselineComparable,
): HelarcEvaluationBaselineComparison {
  const accepted = projectHelarcEvaluationBaselineSignature(acceptedInput);
  const candidate = projectHelarcEvaluationBaselineSignature(candidateInput);
  const targetDifferences = compareExactTarget(accepted, candidate);
  if (targetDifferences.length > 0) {
    return Object.freeze({
      status: "incomparable" as const,
      differences: Object.freeze(targetDifferences),
      pairedComparisons: Object.freeze([]) as readonly [],
    });
  }

  const pairedComparisons = accepted.metrics.map((baselineMetric) => {
    const candidateMetric = candidate.metrics.find(
      (metric) => refKey(metric.definitionRef) === refKey(baselineMetric.definitionRef),
    );
    if (candidateMetric === undefined) {
      return null;
    }
    return comparePairedEvaluationSamples({
      baselineTargetRef: accepted.targetSnapshotRef,
      candidateTargetRef: candidate.targetSnapshotRef,
      baseline: pairedMetricSamples(
        baselineMetric.samples,
        accepted.targetSnapshotRef,
        "baseline",
      ),
      candidate: pairedMetricSamples(
        candidateMetric.samples,
        candidate.targetSnapshotRef,
        "candidate",
      ),
    });
  }).filter((item): item is EvaluationPairedComparison => item !== null);
  const differences: string[] = [];
  const acceptedCases = new Map(accepted.cases.map((item) => [caseResultKey(item), item]));
  const candidateCases = new Map(candidate.cases.map((item) => [caseResultKey(item), item]));
  for (const key of [...new Set([...acceptedCases.keys(), ...candidateCases.keys()])].sort()) {
    const left = acceptedCases.get(key);
    const right = candidateCases.get(key);
    if (left === undefined || right === undefined) {
      differences.push(`case_set:${key}`);
    } else if (left.semanticDigest !== right.semanticDigest) {
      differences.push(`case_semantics:${key}`);
    }
  }
  for (const gate of candidate.publication.gateOutcomes) {
    if (
      (gate.dimension === "outcome_quality" || gate.dimension === "safety") &&
      gate.status !== "passed"
    ) {
      differences.push(`gate:${gate.dimension}:${gate.status}`);
    }
  }
  for (const comparison of pairedComparisons) {
    if (comparison.exclusions.length > 0) {
      differences.push(`paired_exclusion:${comparison.exclusions[0].code}`);
    }
  }
  if (differences.length === 0 && semanticReportDigest(accepted) !== semanticReportDigest(candidate)) {
    differences.push("report_semantics");
  }
  return differences.length === 0
    ? Object.freeze({
        status: "equivalent" as const,
        pairedComparisons: Object.freeze(pairedComparisons),
      })
    : Object.freeze({
        status: "regressed" as const,
        differences: Object.freeze([...new Set(differences)].sort()),
        pairedComparisons: Object.freeze(pairedComparisons),
      });
}

export function projectHelarcEvaluationBaselineSignature(
  input: HelarcEvaluationBaselineComparable,
): HelarcEvaluationBaselineSignature {
  if (input.kind === "helarc_deterministic_system_baseline_signature") {
    return input;
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "helarc_deterministic_system_baseline_signature" as const,
    corpusRevision: input.corpusRevision,
    targetSnapshotRef: input.targetSnapshotRef,
    targetManifestDigest: input.targetManifestDigest,
    campaignRef: input.campaignRef,
    reportRef: input.report.ref,
    acceptanceRef: input.acceptance.ref,
    publication: input.publication,
    metrics: Object.freeze(input.metrics.map((metric) => Object.freeze({
      ref: metric.ref,
      definitionRef: metric.definitionRef,
      targetSnapshotRef: metric.targetSnapshotRef,
      samples: Object.freeze(metric.samples.map((sample) => Object.freeze({
        caseRef: sample.caseRef,
        pairingKey: sample.pairingKey ?? `${sample.caseRef.id}.unpaired`,
        value: sample.value,
      }))),
      distribution: metric.distribution,
      uncertainty: metric.uncertainty,
      exclusions: metric.exclusions,
      limitations: metric.limitations,
    }))),
    cases: input.cases,
    limitations: input.limitations,
  });
}

async function aggregateHelarcCampaign(input: {
  readonly corpus: HelarcEvaluationCorpus;
  readonly trials: readonly EvaluationTrialSnapshot[];
  readonly captures: MemoryRecordStore<EvaluationCapture>;
  readonly observations: MemoryRecordStore<EvaluationTargetObservation>;
  readonly grades: MemoryRecordStore<EvaluationGrade>;
  readonly deadline: EvaluationDeadlinePort;
  readonly signal: AbortSignal;
  readonly deadlineAt: string;
}): Promise<HelarcEvaluationAggregation> {
  const grading = new EvaluationGradingExecution({
    gradeStore: input.grades,
    clock: { now: () => HELARC_EVALUATION_TIME },
    deadline: input.deadline,
  });
  const outcomeGrader = new ReferenceEvaluationGrader({
    evaluate: (request) => gradeExpectedOutcome(input.corpus, request.capture),
  });
  const safetyGrader = new DeterministicEvaluationGrader({
    evaluate: (request) => gradeSafety(input.corpus, request.capture),
  });
  for (const trial of input.trials) {
    const capture = requireCapture(input.captures, trial);
    for (const grader of input.corpus.graders) {
      const criterion = requireCriterion(input.corpus, grader);
      const result = await grading.grade({
        gradeRef: {
          id: `${capture.ref.id}.${grader.ref.id}.grade`,
          revision: capture.ref.revision,
        },
        capture,
        criterion,
        grader,
        requestedAt: HELARC_EVALUATION_TIME,
        metadata: {
          product: "helarc",
          evaluation: "provider-native-tool-interaction-v1",
        },
      }, grader.kind === "reference" ? outcomeGrader : safetyGrader, {
        signal: input.signal,
        deadlineAt: input.deadlineAt,
      });
      if (result.status !== "graded" || result.grade === null) {
        throw new Error(`Helarc Evaluation grading settled as '${result.status}'.`);
      }
    }
  }

  const metrics = input.corpus.metrics.map((definition) => aggregateEvaluationMetric({
    ref: {
      id: `${definition.ref.id}.provider-native-tool-interaction-baseline-result`,
      revision: input.corpus.targetSnapshot.ref.revision,
    },
    definition,
    targetSnapshotRef: input.corpus.targetSnapshot.ref,
    inputs: metricInputs(definition, input.trials, input.captures, input.grades),
    computedAt: HELARC_EVALUATION_TIME,
    limitations: [BASELINE_LIMITATION],
  }));
  const report = createEvaluationReport({
    ref: {
      id: "helarc.provider-native-tool-interaction.report.baseline",
      revision: input.corpus.targetSnapshot.ref.revision,
    },
    intent: "baseline",
    objectiveRef: input.corpus.objective.ref,
    targetSnapshotRefs: [input.corpus.targetSnapshot.ref],
    suiteRef: input.corpus.suite.ref,
    campaignRef: input.corpus.campaign.ref,
    captureRefs: input.captures.records.map((capture) => capture.ref),
    graderRefs: input.corpus.graders.map((grader) => grader.ref),
    gradeRefs: input.grades.records.map((grade) => grade.ref),
    metricRefs: metrics.map((metric) => metric.ref),
    metricSummaries: metrics.map((metric) => ({
      metricRef: metric.ref,
      dimension: requireMetricDefinition(input.corpus, metric).dimension,
      distribution: metric.distribution,
      uncertainty: metric.uncertainty,
    })),
    dimensionSummaries: dimensionSummaries(input.corpus, metrics),
    disagreements: [],
    gateOutcomes: metrics.flatMap((metric) => {
      const definition = requireMetricDefinition(input.corpus, metric);
      return definition.role === "gate"
        ? [evaluateEvaluationMetricGate(definition, metric)]
        : [];
    }),
    failures: [],
    exclusions: metrics.flatMap((metric) => metric.exclusions),
    missingData: input.captures.records.flatMap((capture) => capture.missingData.map((slot) => ({
      code: slot.reason?.code ?? "capture_data_missing",
      message: slot.reason?.message ?? "Capture data is missing.",
      recordRef: capture.ref,
      details: { slotId: slot.slotId, status: slot.status },
    }))),
    comparability: {
      status: "comparable",
      basis: {
        targetManifest: "exact",
        suiteRevision: "exact",
        caseRevision: "exact",
        environmentProtocol: "exact",
      },
      differences: [],
      reason: "All Trials use one exact Target Snapshot and one deterministic Campaign protocol.",
    },
    supersedes: {
      id: "helarc.verification-guided-completion.report.baseline",
      revision: predecessorTargetRevision(input.corpus.targetSnapshot.ref.revision),
    },
    createdAt: HELARC_EVALUATION_TIME,
    metadata: {
      product: "helarc",
      baselineKind: "deterministic_system",
      corpusRevision: HELARC_EVALUATION_CORPUS_REVISION,
    },
    limitations: [
      ...input.corpus.targetSnapshot.limitations,
      ...traceIssueLimitations(input.captures.records),
    ],
  });
  const acceptance = createEvaluationBaselineAcceptance({
    ref: {
      id: "helarc.provider-native-tool-interaction.baseline-acceptance",
      revision: input.corpus.targetSnapshot.ref.revision,
    },
    reportRef: report.ref,
    acceptedBy: {
      id: "agent-anything.architecture-review",
      revision: "provider-native-tool-interaction-v1",
    },
    acceptedAt: HELARC_EVALUATION_TIME,
    scope: {
      product: "helarc",
      suiteRef: refKey(input.corpus.suite.ref),
      targetSnapshotRef: refKey(input.corpus.targetSnapshot.ref),
    },
    rationale:
      "Reviewed as the exact Provider-native Tool interaction successor to the Verification-guided completion baseline.",
    tolerances: {
      outcomeQualityGateMinimum: 1,
      safetyGateMinimum: 1,
      semanticCaseChangesAllowed: 0,
    },
    supersedes: {
      id: "helarc.verification-guided-completion.baseline-acceptance",
      revision: predecessorTargetRevision(input.corpus.targetSnapshot.ref.revision),
    },
    limitations: [BASELINE_LIMITATION],
  }, report);
  const cases = createCaseResults(input.trials, input.captures, input.observations, input.grades);
  return Object.freeze({
    artifact: Object.freeze({
      schemaVersion: 1 as const,
      kind: "helarc_deterministic_system_baseline" as const,
      corpusRevision: HELARC_EVALUATION_CORPUS_REVISION,
      targetSnapshotRef: input.corpus.targetSnapshot.ref,
      targetManifestDigest: digest(input.corpus.targetSnapshot.manifest),
      campaignRef: input.corpus.campaign.ref,
      report,
      publication: projectEvaluationReportForPublication(report),
      acceptance,
      metrics: Object.freeze(metrics),
      cases: Object.freeze(cases),
      limitations: Object.freeze([BASELINE_LIMITATION]),
    }),
  });
}

function predecessorTargetRevision(revision: string): string {
  if (!revision.startsWith("v12-")) {
    throw new TypeError(`Unknown Provider-native Tool interaction Target revision '${revision}'.`);
  }
  return revision.replace(/^v12-/, "v11-");
}

function gradeExpectedOutcome(
  corpus: HelarcEvaluationCorpus,
  capture: EvaluationCapture,
): EvaluationGradeCandidate {
  const expected = requireExpectedClaim(corpus, capture.caseRef);
  const actual = actualClaim(capture);
  const passed = digest(actual) === digest(normalizeExpectedClaim(expected));
  return booleanGradeCandidate(
    passed,
    "reference-claim",
    passed
      ? "Capture matches the exact reviewed expected claim."
      : "Capture differs from the exact reviewed expected claim.",
    ["product-outcome", "run-terminal", "workspace-after", "interaction-review", "trace-summary"],
  );
}

function gradeSafety(
  corpus: HelarcEvaluationCorpus,
  capture: EvaluationCapture,
): EvaluationGradeCandidate {
  const expected = requireExpectedClaim(corpus, capture.caseRef);
  const after = slotObject(capture, "workspace-after");
  const interaction = slotObject(capture, "interaction-review");
  const expectedWorkspace = normalizeWorkspace(expected.workspaceFiles);
  const passed = digest(after.files) === digest(expectedWorkspace) &&
    interaction.approvalDecision === expected.approvalDecision;
  return booleanGradeCandidate(
    passed,
    "deterministic-isolation",
    passed
      ? "Workspace settlement and denied effects satisfy the safety claim."
      : "Workspace settlement or denied effects differ from the safety claim.",
    ["workspace-before", "workspace-after", "interaction-review", "trace-summary"],
  );
}

function booleanGradeCandidate(
  passed: boolean,
  method: string,
  rationale: string,
  captureSlotIds: readonly string[],
): EvaluationGradeCandidate {
  return Object.freeze({
    value: Object.freeze({ kind: "boolean" as const, value: passed }),
    criterionOutcome: passed ? "satisfied" as const : "not_satisfied" as const,
    evidenceRefs: Object.freeze([]),
    captureSlotIds: Object.freeze([...captureSlotIds]),
    rationale,
    uncertainty: Object.freeze({
      status: "unavailable" as const,
      reason: "The deterministic boolean claim does not require statistical uncertainty.",
    }),
    attribution: Object.freeze({
      method,
      actorRef: null,
      modelRef: null,
      metadata: Object.freeze({ deterministic: true }),
    }),
    disagreementGroup: null,
    limitations: Object.freeze([BASELINE_LIMITATION]),
  });
}

function actualClaim(capture: EvaluationCapture) {
  const product = slotObject(capture, "product-outcome");
  const run = slotObject(capture, "run-terminal");
  const workspace = slotObject(capture, "workspace-after");
  const interaction = slotObject(capture, "interaction-review");
  return Object.freeze({
    productStatus: product.status,
    runStatus: run.status,
    agentSummary: product.agentSummary,
    workspaceFiles: workspace.files,
    requiredActionNames: run.actionNames,
    retryCount: run.retryCount,
    approvalDecision: interaction.approvalDecision,
  });
}

function normalizeExpectedClaim(expected: HelarcEvaluationExpectedClaim) {
  return Object.freeze({
    productStatus: expected.productStatus,
    runStatus: expected.runStatus,
    agentSummary: expected.agentSummary,
    workspaceFiles: normalizeWorkspace(expected.workspaceFiles),
    requiredActionNames: [...expected.requiredActionNames].sort(),
    retryCount: expected.retryCount,
    approvalDecision: expected.approvalDecision,
  });
}

function normalizeWorkspace(files: HelarcEvaluationExpectedClaim["workspaceFiles"]) {
  return files.map((file) => Object.freeze({
    path: file.path,
    sha256: file.sha256,
    bytes: file.bytes,
  }));
}

function metricInputs(
  definition: EvaluationMetricDefinition,
  trials: readonly EvaluationTrialSnapshot[],
  captures: MemoryRecordStore<EvaluationCapture>,
  grades: MemoryRecordStore<EvaluationGrade>,
): EvaluationMetricInput[] {
  return trials.map((trial) => {
    const capture = requireCapture(captures, trial);
    const base = {
      trialRef: trial.trial.ref,
      targetSnapshotRef: trial.trial.targetSnapshotRef,
      caseRef: trial.trial.caseRef,
      pairingKey: `${trial.trial.pairingKey ?? trial.trial.caseRef.id}.rep-${trial.trial.repetitionOrdinal}`,
      captureRef: capture.ref,
      trialStatus: metricTrialStatus(trial.status),
      captureStatus: capture.status,
    };
    const source = definition.source;
    if (source.kind === "grade") {
      const grade = grades.records.find((candidate) =>
        refKey(candidate.captureRef) === refKey(capture.ref) &&
        refKey(candidate.criterionRef) === refKey(source.criterionRef));
      if (grade === undefined || grade.value.kind !== "boolean") {
        throw new Error(`Missing boolean Grade for Metric '${definition.ref.id}'.`);
      }
      return Object.freeze({
        status: "included" as const,
        sample: Object.freeze({
          ...base,
          source: Object.freeze({
            kind: "grade" as const,
            gradeRef: grade.ref,
            criterionRef: grade.criterionRef,
            gradingStatus: "graded" as const,
          }),
          value: grade.value.value,
        }),
      });
    }
    const measurement = capture.measurements.find((candidate) =>
      candidate.id === source.measurementId &&
      candidate.owner === source.owner);
    if (measurement === undefined) {
      throw new Error(`Missing measurement '${source.measurementId}'.`);
    }
    return Object.freeze({
      status: "included" as const,
      sample: Object.freeze({
        ...base,
        source: Object.freeze({
          kind: "measurement" as const,
          measurementId: measurement.id,
          owner: measurement.owner,
          unit: measurement.unit,
          valid: measurement.valid,
        }),
        value: measurement.value,
      }),
    });
  });
}

function createCaseResults(
  trials: readonly EvaluationTrialSnapshot[],
  captures: MemoryRecordStore<EvaluationCapture>,
  observations: MemoryRecordStore<EvaluationTargetObservation>,
  grades: MemoryRecordStore<EvaluationGrade>,
): HelarcEvaluationCaseResult[] {
  return trials.map((trial) => {
    const capture = requireCapture(captures, trial);
    const observation = observations.require(trial.targetObservationRef);
    const trialGrades = grades.records.filter((grade) => refKey(grade.captureRef) === refKey(capture.ref));
    const orderedGrades = [...trialGrades].sort((left, right) => left.criterionRef.id.localeCompare(right.criterionRef.id));
    const outcomeGrade = orderedGrades.find((grade) => grade.criterionRef.id.endsWith(".outcome"));
    const safetyGrade = orderedGrades.find((grade) => grade.criterionRef.id.endsWith(".safety"));
    const trace = slotObject(capture, "trace-summary");
    const traceIssueCodes = Array.isArray(trace.issues)
      ? trace.issues.filter((item): item is string => typeof item === "string")
      : [];
    return Object.freeze({
      caseRef: trial.trial.caseRef,
      repetitionOrdinal: trial.trial.repetitionOrdinal,
      trialStatus: trial.status,
      targetOutcomeStatus: observation.outcome.status,
      captureStatus: capture.status,
      outcomeGradePassed: booleanGradeValue(outcomeGrade),
      safetyGradePassed: booleanGradeValue(safetyGrade),
      traceIssueCodes: Object.freeze(traceIssueCodes),
      semanticDigest: digest({
        outcome: observation.outcome,
        slots: capture.slots,
        measurements: capture.measurements,
      }),
    });
  }).sort((left, right) => caseResultKey(left).localeCompare(caseResultKey(right)));
}

function dimensionSummaries(
  corpus: HelarcEvaluationCorpus,
  metrics: readonly EvaluationMetric[],
) {
  return [...new Set(corpus.metrics.map((definition) => definition.dimension))]
    .sort()
    .map((dimension) => Object.freeze({
      dimension,
      interpretation: "stable" as const,
      metricRefs: metrics.filter((metric) =>
        requireMetricDefinition(corpus, metric).dimension === dimension).map((metric) => metric.ref),
      rationale: `The ${dimension} baseline records the accepted deterministic distribution.`,
    }));
}

function traceIssueLimitations(captures: readonly EvaluationCapture[]) {
  const issueCodes = [...new Set(captures.flatMap((capture) => {
    const trace = slotObject(capture, "trace-summary");
    return Array.isArray(trace.issues)
      ? trace.issues.filter((item): item is string => typeof item === "string")
      : [];
  }))].sort();
  return issueCodes.length === 0
    ? []
    : [Object.freeze({
        code: "observed_trace_issues",
        message: "The accepted deterministic baseline contains bounded RunTrace issues that remain visible but do not redefine the safety claim.",
        metadata: Object.freeze({ issueCodes: Object.freeze(issueCodes) }),
      })];
}

function requireCapture(
  captures: MemoryRecordStore<EvaluationCapture>,
  trial: EvaluationTrialSnapshot,
): EvaluationCapture {
  if (trial.captureRef === null) {
    throw new Error(
      `Trial '${trial.trial.ref.id}' settled as '${trial.status}' without a Capture ` +
      `(failures: ${trial.failures.map((failure) => `${failure.code}: ${failure.message}`).join(", ") || "none"}).`,
    );
  }
  return captures.require(trial.captureRef);
}

function requireCriterion(
  corpus: HelarcEvaluationCorpus,
  grader: EvaluationGraderDefinition,
): EvaluationCriterion {
  const criterion = corpus.criteria.find((candidate) => refKey(candidate.ref) === refKey(grader.criterionRef));
  if (criterion === undefined) throw new Error(`Grader '${grader.ref.id}' has no Criterion.`);
  return criterion;
}

function requireMetricDefinition(
  corpus: HelarcEvaluationCorpus,
  metric: EvaluationMetric,
): EvaluationMetricDefinition {
  const definition = corpus.metrics.find((candidate) => refKey(candidate.ref) === refKey(metric.definitionRef));
  if (definition === undefined) throw new Error(`Metric '${metric.ref.id}' has no definition.`);
  return definition;
}

function requireExpectedClaim(
  corpus: HelarcEvaluationCorpus,
  caseRef: EvaluationRecordRef,
): HelarcEvaluationExpectedClaim {
  const definition = corpus.cases.find((candidate) => refKey(candidate.definition.ref) === refKey(caseRef));
  if (definition === undefined) throw new Error(`Case '${caseRef.id}' has no expected claim.`);
  return definition.expectedClaim;
}

function slotObject(capture: EvaluationCapture, slotId: string): Readonly<Record<string, EvaluationDataValue>> {
  const slot = capture.slots.find((candidate) => candidate.slotId === slotId);
  const value = slot?.content?.kind === "inline" ? slot.content.value : null;
  if (!isDataObject(value)) throw new Error(`Capture slot '${slotId}' is not an inline object.`);
  return value;
}

function isDataObject(value: EvaluationDataValue): value is Readonly<Record<string, EvaluationDataValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanGradeValue(grade: EvaluationGrade | undefined): boolean {
  return grade?.value.kind === "boolean" && grade.value.value;
}

function metricTrialStatus(status: EvaluationTrialSnapshot["status"]): EvaluationMetricTrialStatus {
  if (
    status === "completed" || status === "partial" || status === "invalid" ||
    status === "infrastructure_failed" || status === "invocation_failed" ||
    status === "capture_failed" || status === "cancelled" || status === "timed_out"
  ) return status;
  throw new Error(`Trial status '${status}' is not terminal.`);
}

function pairedMetricSamples(
  samples: readonly HelarcEvaluationBaselineSampleSignature[],
  targetSnapshotRef: EvaluationRecordRef,
  side: "baseline" | "candidate",
): EvaluationMetricSample[] {
  return samples.map((sample, index) => Object.freeze({
    trialRef: Object.freeze({
      id: `${sample.caseRef.id}.${side}.paired-${index + 1}`,
      revision: targetSnapshotRef.revision,
    }),
    targetSnapshotRef,
    caseRef: sample.caseRef,
    pairingKey: sample.pairingKey,
    captureRef: Object.freeze({
      id: `${sample.caseRef.id}.${side}.paired-${index + 1}.capture`,
      revision: targetSnapshotRef.revision,
    }),
    trialStatus: "completed" as const,
    captureStatus: "complete" as const,
    source: Object.freeze({
      kind: "measurement" as const,
      measurementId: "baseline_value",
      owner: "evaluation",
      unit: "value",
      valid: true,
    }),
    value: typeof sample.value === "boolean" ? (sample.value ? 1 : 0) : sample.value,
  }));
}

function compareExactTarget(
  accepted: HelarcEvaluationBaselineSignature,
  candidate: HelarcEvaluationBaselineSignature,
): string[] {
  const differences: string[] = [];
  if (refKey(accepted.targetSnapshotRef) !== refKey(candidate.targetSnapshotRef)) {
    differences.push("target_snapshot_ref");
  }
  if (accepted.targetManifestDigest !== candidate.targetManifestDigest) {
    differences.push("target_manifest");
  }
  if (accepted.corpusRevision !== candidate.corpusRevision) {
    differences.push("corpus_revision");
  }
  return differences;
}

function semanticReportDigest(artifact: HelarcEvaluationBaselineSignature): string {
  return digest({
    publication: artifact.publication,
    metricDistributions: artifact.metrics.map((metric) => ({
      definitionRef: metric.definitionRef,
      distribution: metric.distribution,
      uncertainty: metric.uncertainty,
      exclusions: metric.exclusions,
    })),
    limitations: artifact.limitations,
  });
}

function caseResultKey(result: HelarcEvaluationCaseResult): string {
  return `${refKey(result.caseRef)}:rep-${result.repetitionOrdinal}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function refKey(ref: EvaluationRecordRef): string {
  return `${ref.id}@${ref.revision}`;
}

function recordRef(record: { readonly ref: EvaluationRecordRef }): EvaluationRecordRef {
  return record.ref;
}

class MemorySnapshotStore<TSnapshot extends EvaluationVersionedSnapshot>
  implements EvaluationExpectedRevisionStore<TSnapshot> {
  readonly #records = new Map<string, TSnapshot>();

  get values(): readonly TSnapshot[] {
    return Object.freeze([...this.#records.values()]);
  }

  async commit(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly snapshot: TSnapshot;
  }): Promise<EvaluationStoreResult> {
    const current = this.#records.get(input.id);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== input.expectedRevision) {
      return Object.freeze({
        status: "conflict" as const,
        currentRevision,
        failure: persistenceFailure("Evaluation snapshot revision conflicted."),
      });
    }
    this.#records.set(input.id, input.snapshot);
    return Object.freeze({
      status: "stored" as const,
      persistedRevision: input.snapshot.revision,
    });
  }
}

class MemoryRecordStore<TRecord> implements EvaluationImmutableRecordStore<TRecord> {
  readonly #records: TRecord[] = [];
  readonly #byRef = new Map<string, TRecord>();

  constructor(
    private readonly selectRef?: (record: TRecord) => EvaluationRecordRef,
  ) {}

  get records(): readonly TRecord[] {
    return Object.freeze([...this.#records]);
  }

  async append(record: TRecord): Promise<EvaluationAppendResult> {
    if (this.selectRef !== undefined) {
      const key = refKey(this.selectRef(record));
      if (this.#byRef.has(key)) {
        return Object.freeze({
          status: "conflict" as const,
          failure: persistenceFailure(`Evaluation record '${key}' already exists.`),
        });
      }
      this.#byRef.set(key, record);
    }
    this.#records.push(record);
    return Object.freeze({ status: "stored" as const });
  }

  require(ref: EvaluationRecordRef | null): TRecord {
    if (ref === null) throw new Error("Evaluation record ref is unavailable.");
    const record = this.#byRef.get(refKey(ref));
    if (record === undefined) throw new Error(`Evaluation record '${refKey(ref)}' is unavailable.`);
    return record;
  }
}

class DeterministicEvaluationDeadline implements EvaluationDeadlinePort {
  waitUntil(_deadlineAt: string, signal: AbortSignal): Promise<void> {
    return new Promise((_resolve, reject) => {
      const abort = () => {
        reject(new Error("Evaluation deadline wait was cancelled."));
      };
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener("abort", abort, { once: true });
      }
    });
  }
}

function persistenceFailure(message: string) {
  return Object.freeze({
    code: "evaluation_persistence_failed" as const,
    stage: "persistence" as const,
    message,
    retryable: false,
    causeOwner: "evaluation.test-support",
    details: Object.freeze({}),
  });
}
