import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSettlementCauseCode } from "@agent-anything/agent-runtime/run";

import { createEvaluationCampaign } from "@agent-anything/evaluation/campaign";
import {
  assembleEvaluationCapture,
  type EvaluationCapture,
  type EvaluationCaptureContribution,
  type EvaluationCapturePort,
  type EvaluationMeasurement,
} from "@agent-anything/evaluation/capture";
import {
  createEvaluationFailure,
  type EvaluationDataObject,
  type EvaluationDataValue,
  type EvaluationFailure,
  type EvaluationRecordRef,
} from "@agent-anything/evaluation/definition";
import {
  createEvaluationGrade,
  type EvaluationGrade,
  type EvaluationGradeCandidate,
} from "@agent-anything/evaluation/grading";
import {
  aggregateEvaluationMetric,
  evaluateEvaluationMetricGate,
  type EvaluationMetric,
  type EvaluationMetricDefinition,
  type EvaluationMetricInput,
} from "@agent-anything/evaluation/metrics";
import {
  createEvaluationReport,
  projectEvaluationReportForPublication,
  type EvaluationReport,
  type EvaluationReportPublicationProjection,
} from "@agent-anything/evaluation/report";
import type {
  EvaluationAppendResult,
  EvaluationExpectedRevisionStore,
  EvaluationImmutableRecordStore,
  EvaluationStoreResult,
  EvaluationVersionedSnapshot,
} from "@agent-anything/evaluation/persistence";
import {
  EvaluationTrialExecution,
  createEvaluationTrial,
  projectEvaluationTrial,
  type EvaluationCleanupOutcome,
  type EvaluationDeadlinePort,
  type EvaluationEnvironmentPort,
  type EvaluationTargetObservation,
  type EvaluationTargetPort,
  type EvaluationTrial,
  type EvaluationTrialProjection,
  type EvaluationTrialSnapshot,
} from "@agent-anything/evaluation/trial";
import {
  createProviderAttemptInterruption,
  providerResponseUsage,
  providerResultFromInterruption,
  type Provider,
} from "@agent-anything/model-interaction";

import { FakeNativeToolProvider } from "../../../provider/FakeNativeToolProvider.js";
import {
  runCurrentTurnToolExposureDeterministicEvaluation,
} from "../../../current-turn-tool-exposure-evaluation/CurrentTurnToolExposureEvaluation.js";
import {
  runDelegationTransferDeterministicEvaluation,
} from "../../../delegation-transfer-evaluation/DelegationTransferEvaluation.js";
import {
  runRunLifecycleHookDeterministicEvaluation,
} from "../../../run-lifecycle-hook-evaluation/RunLifecycleHookEvaluation.js";
import {
  HELARC_EVALUATION_TIME,
  createHelarcEvaluationCorpus,
  type HelarcEvaluationScenario,
} from "../HelarcEvaluationCorpus.js";
import {
  executeHelarcEvaluationCase,
} from "../HelarcEvaluationTarget.js";
import {
  HELARC_OPERATIONAL_ABSOLUTE_GATES,
  HELARC_OPERATIONAL_EVALUATION_REVISION,
  HELARC_OPERATIONAL_EVALUATION_TIME,
  createHelarcOperationalConformanceCases,
  createHelarcOperationalEvaluationProgram,
  createHelarcOperationalTargetSnapshot,
  type HelarcOperationalAbsoluteGate,
  type HelarcOperationalConformanceCaseId,
  type HelarcOperationalTargetValues,
} from "./HelarcOperationalEvaluation.js";

export const HELARC_OPERATIONAL_CONFORMANCE_REVISION =
  "helarc-operational-conformance-v3";

export interface HelarcOperationalConformanceFacts {
  readonly caseId: HelarcOperationalConformanceCaseId;
  readonly targetOutcome: {
    readonly status: "succeeded" | "failed" | "cancelled";
    readonly owner: string;
    readonly code: string | null;
    readonly summary: string;
  };
  readonly invariantSatisfied: boolean;
  readonly terminal: EvaluationDataObject;
  readonly runTree: EvaluationDataObject;
  readonly actionsAndOperations: EvaluationDataObject;
  readonly verification: EvaluationDataObject;
  readonly effects: EvaluationDataObject;
  readonly gates: Readonly<Record<HelarcOperationalAbsoluteGate, boolean>>;
  readonly diagnostics: {
    readonly reliability: number;
    readonly trajectory: number;
    readonly verification: number;
    readonly latencyMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedCost: number;
    readonly toolCalls: number;
    readonly retries: number;
    readonly humanInteraction: number;
  };
}

export type HelarcOperationalConformanceCaseRunner = (
  signal: AbortSignal,
) => Promise<HelarcOperationalConformanceFacts>;

export interface HelarcOperationalConformanceExecutionOptions {
  readonly caseRunners?: Partial<
    Readonly<Record<HelarcOperationalConformanceCaseId, HelarcOperationalConformanceCaseRunner>>
  >;
  readonly cleanupFailureCaseIds?: readonly HelarcOperationalConformanceCaseId[];
}

export interface HelarcOperationalConformanceTrialResult {
  readonly caseId: HelarcOperationalConformanceCaseId;
  readonly projection: EvaluationTrialProjection;
  readonly environmentFingerprint: string | null;
  readonly fixtureDigest: string;
  readonly gradePassed: boolean | null;
  readonly targetOutcomeStatus: EvaluationTargetObservation["outcome"]["status"] | null;
  readonly infrastructureFailureCodes: readonly string[];
}

export interface HelarcOperationalConformanceReport {
  readonly schemaVersion: 1;
  readonly kind: "helarc_operational_conformance";
  readonly revision: typeof HELARC_OPERATIONAL_CONFORMANCE_REVISION;
  readonly status: "passed" | "failed" | "unavailable";
  readonly report: EvaluationReport;
  readonly publication: EvaluationReportPublicationProjection;
  readonly trials: readonly HelarcOperationalConformanceTrialResult[];
  readonly metrics: readonly EvaluationMetric[];
  readonly digest: string;
  readonly limitations: readonly string[];
}

interface LeaseMaterial {
  readonly caseId: HelarcOperationalConformanceCaseId;
  readonly root: string;
  readonly fixtureDigest: string;
  readonly environmentFingerprint: string;
}

interface TrialExecutionRecord {
  readonly caseId: HelarcOperationalConformanceCaseId;
  readonly trial: EvaluationTrial;
  readonly snapshot: EvaluationTrialSnapshot;
  readonly observation: EvaluationTargetObservation | null;
  readonly capture: EvaluationCapture | null;
  readonly facts: HelarcOperationalConformanceFacts | null;
  readonly fixtureDigest: string;
}

export async function runHelarcOperationalConformance(
  options: HelarcOperationalConformanceExecutionOptions = {},
): Promise<HelarcOperationalConformanceReport> {
  const profile = createHelarcOperationalEvaluationProgram().profiles.harness_conformance;
  const caseProfiles = createHelarcOperationalConformanceCases();
  const targetSnapshot = createHelarcOperationalTargetSnapshot({
    profile,
    ref: ref("helarc.operational.harness-conformance.target"),
    targetRef: ref("helarc.operational.harness-conformance.scripted-target"),
    sourceRevision: HELARC_OPERATIONAL_CONFORMANCE_REVISION,
    values: deterministicTargetValues(profile.suite.ref),
    targetName: "combined deterministic Harness target",
  });
  const campaign = createEvaluationCampaign({
    ref: profile.refs.campaign,
    objectiveRef: profile.objective.ref,
    targetSnapshotRefs: [targetSnapshot.ref],
    suiteRef: profile.suite.ref,
    caseRefs: profile.suite.caseRefs,
    capturePolicyRef: profile.capturePolicy.ref,
    graderDefinitionRefs: profile.graders.map(({ ref }) => ref),
    metricDefinitionRefs: profile.metrics.map(({ ref }) => ref),
    environmentProtocolRef: profile.refs.environmentProtocol,
    repetitions: 1,
    seedSchedule: ["combined-harness-conformance-seed"],
    pairing: {
      kind: "by_case",
      caseKeys: caseProfiles.map(({ definition }) => ({
        caseRef: definition.ref,
        pairingKey: definition.pairingKey!,
      })),
    },
    budget: {
      maximumDurationMs: 600_000,
      maximumTrials: caseProfiles.length,
      maximumCost: 0,
    },
    maximumConcurrency: 1,
    intent: "baseline",
    createdAt: HELARC_OPERATIONAL_EVALUATION_TIME,
    metadata: { protocolRevision: HELARC_OPERATIONAL_CONFORMANCE_REVISION },
  });
  const records = await executeTrials({
    caseProfiles,
    targetSnapshotRef: targetSnapshot.ref,
    campaignRef: campaign.ref,
    environmentProtocolRef: campaign.environmentProtocolRef,
    capturePolicy: profile.capturePolicy,
    options,
  });
  const grades = records.flatMap((record) => {
    if (record.capture === null || record.facts === null) return [];
    const candidate = gradeHelarcOperationalConformanceFacts(record.facts);
    return [createEvaluationGrade({
      ref: ref(`${record.trial.ref.id}.grade`),
      captureRef: record.capture.ref,
      criterionRef: profile.criteria[0]!.ref,
      graderRef: profile.graders[0]!.ref,
      ...candidate,
      gradedAt: HELARC_OPERATIONAL_EVALUATION_TIME,
    })];
  });
  const metrics = profile.metrics.map((definition) => aggregateEvaluationMetric({
    ref: ref(`${definition.ref.id}.result`),
    definition,
    targetSnapshotRef: targetSnapshot.ref,
    inputs: metricInputs(definition, records, grades),
    computedAt: HELARC_OPERATIONAL_EVALUATION_TIME,
    limitations: [limitation()],
  }));
  const gateOutcomes = metrics.flatMap((metric) => {
    const definition = requireMetricDefinition(profile.metrics, metric);
    return definition.role === "gate"
      ? [evaluateEvaluationMetricGate(definition, metric)]
      : [];
  });
  const failures = records.flatMap(({ snapshot }) => snapshot.failures);
  const report = createEvaluationReport({
    ref: profile.refs.report,
    intent: "baseline",
    objectiveRef: profile.objective.ref,
    targetSnapshotRefs: [targetSnapshot.ref],
    suiteRef: profile.suite.ref,
    campaignRef: campaign.ref,
    captureRefs: records.flatMap(({ capture }) => capture === null ? [] : [capture.ref]),
    graderRefs: profile.graders.map(({ ref }) => ref),
    gradeRefs: grades.map(({ ref }) => ref),
    metricRefs: metrics.map(({ ref }) => ref),
    metricSummaries: metrics.map((metric) => ({
      metricRef: metric.ref,
      dimension: requireMetricDefinition(profile.metrics, metric).dimension,
      distribution: metric.distribution,
      uncertainty: metric.uncertainty,
    })),
    dimensionSummaries: [...new Set(profile.metrics.map(({ dimension }) => dimension))]
      .sort()
      .map((dimension) => ({
        dimension,
        interpretation: "stable" as const,
        metricRefs: metrics.filter((metric) =>
          requireMetricDefinition(profile.metrics, metric).dimension === dimension
        ).map(({ ref }) => ref),
        rationale: `The combined deterministic ${dimension} evidence is interpreted only after absolute gates.`,
      })),
    disagreements: [],
    gateOutcomes,
    failures,
    exclusions: metrics.flatMap(({ exclusions }) => exclusions),
    missingData: records.flatMap((record) => record.capture === null
      ? [{
          code: "evaluation_infrastructure_failure",
          message: "The Trial did not produce an admissible Capture.",
          recordRef: record.trial.ref,
          details: { caseId: record.caseId },
        }]
      : []),
    comparability: {
      status: "comparable",
      basis: {
        targetManifest: "exact",
        suiteRevision: "exact",
        caseRevision: "exact",
        environmentProtocol: "exact",
      },
      differences: [],
      reason: "Every deterministic Trial uses the declared target, Case, and isolated environment protocol.",
    },
    supersedes: null,
    createdAt: HELARC_OPERATIONAL_EVALUATION_TIME,
    metadata: {
      protocolRevision: HELARC_OPERATIONAL_CONFORMANCE_REVISION,
      claim: "harness_conformance",
      targetFailuresRemainBehaviorEvidence: true,
      cleanupFromTrialTerminalSnapshot: true,
    },
    limitations: [limitation()],
  });
  const hasInfrastructureFailure = records.some(({ snapshot }) =>
    snapshot.status !== "completed" && snapshot.status !== "partial"
  );
  const hasFailedGate = report.gateOutcomes.some(({ status }) => status !== "passed");
  const status = hasInfrastructureFailure
    ? "unavailable" as const
    : hasFailedGate
      ? "failed" as const
      : "passed" as const;
  const trials = records.map((record) => Object.freeze({
    caseId: record.caseId,
    projection: projectEvaluationTrial(record.snapshot, record.observation),
    environmentFingerprint: record.snapshot.environmentLease?.environmentFingerprint ?? null,
    fixtureDigest: record.fixtureDigest,
    gradePassed: gradeForTrial(grades, record.capture)?.criterionOutcome === "satisfied"
      ? true
      : record.capture === null
        ? null
        : false,
    targetOutcomeStatus: record.observation?.outcome.status ?? null,
    infrastructureFailureCodes: Object.freeze(record.snapshot.failures.map(({ code }) => code)),
  }));
  const material = deepFreeze({
    schemaVersion: 1 as const,
    kind: "helarc_operational_conformance" as const,
    revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION as typeof HELARC_OPERATIONAL_CONFORMANCE_REVISION,
    status,
    report,
    publication: projectEvaluationReportForPublication(report),
    trials,
    metrics,
    limitations: [
      "Scripted deterministic evidence proves Harness conformance, not real-model or Product effectiveness.",
      "Cleanup truth is read from the terminal Evaluation Trial snapshot after Capture settlement.",
    ],
  });
  return deepFreeze({ ...material, digest: sha256(stableJson(material)) });
}

export function gradeHelarcOperationalConformanceFacts(
  facts: HelarcOperationalConformanceFacts,
): EvaluationGradeCandidate {
  const applicable = createHelarcOperationalConformanceCases()
    .find(({ id }) => id === facts.caseId)?.applicableGates ?? [];
  const failedGates = applicable.filter((gate) => !facts.gates[gate]);
  const passed = facts.invariantSatisfied && failedGates.length === 0;
  return deepFreeze({
    value: {
      kind: "scalar" as const,
      value: passed ? 1 : 0,
      minimum: 0,
      maximum: 1,
      unit: "ratio",
    },
    criterionOutcome: passed ? "satisfied" as const : "not_satisfied" as const,
    evidenceRefs: [],
    captureSlotIds: [
      "terminal",
      "run_tree",
      "actions_and_operations",
      "verification",
      "effects",
      "environment",
    ],
    rationale: passed
      ? `The '${facts.caseId}' authoritative invariant and all applicable absolute gates passed.`
      : `The '${facts.caseId}' Case failed: ${failedGates.join(", ") || "authoritative invariant"}.`,
    uncertainty: { status: "unavailable" as const, reason: "Deterministic boolean grading has no stochastic uncertainty." },
    attribution: {
      method: "deterministic_owner_fact_grading",
      actorRef: null,
      modelRef: null,
      metadata: { caseId: facts.caseId },
    },
    disagreementGroup: null,
    limitations: [limitation()],
  });
}

async function executeTrials(input: {
  readonly caseProfiles: ReturnType<typeof createHelarcOperationalConformanceCases>;
  readonly targetSnapshotRef: EvaluationRecordRef;
  readonly campaignRef: EvaluationRecordRef;
  readonly environmentProtocolRef: EvaluationRecordRef;
  readonly capturePolicy: ReturnType<typeof createHelarcOperationalEvaluationProgram>["profiles"]["harness_conformance"]["capturePolicy"];
  readonly options: HelarcOperationalConformanceExecutionOptions;
}): Promise<readonly TrialExecutionRecord[]> {
  const runners = { ...defaultCaseRunners(), ...input.options.caseRunners };
  const leases = new Map<string, LeaseMaterial>();
  const factsByObservation = new Map<string, HelarcOperationalConformanceFacts>();
  const factsByCase = new Map<HelarcOperationalConformanceCaseId, HelarcOperationalConformanceFacts>();
  const fixtureDigests = new Map<HelarcOperationalConformanceCaseId, string>();
  const cleanupFailures = new Set(input.options.cleanupFailureCaseIds ?? []);
  const environment = createEnvironment(leases, fixtureDigests, cleanupFailures);
  const target: EvaluationTargetPort = Object.freeze({
    async invoke(request: Parameters<EvaluationTargetPort["invoke"]>[0]) {
      const lease = leases.get(refKey(request.leaseRef));
      if (lease === undefined) {
        return { status: "failed" as const, failure: failure("evaluation_invocation_failed", "invocation", "The conformance lease is unavailable.") };
      }
      const runner = runners[lease.caseId];
      const facts = await runner(request.signal);
      factsByCase.set(lease.caseId, facts);
      const observationRef = ref(`${request.trial.ref.id}.observation`);
      factsByObservation.set(refKey(observationRef), facts);
      return {
        status: "observed" as const,
        observation: {
          ref: observationRef,
          trialRef: request.trial.ref,
          targetSnapshotRef: request.trial.targetSnapshotRef,
          caseRef: request.trial.caseRef,
          outcome: {
            ...facts.targetOutcome,
            data: {
              caseId: facts.caseId,
              invariantSatisfied: facts.invariantSatisfied,
              gateFailures: Object.entries(facts.gates)
                .filter(([, value]) => !value)
                .map(([id]) => id),
            },
          },
          childRuns: [],
          artifactRefs: [],
          observedAt: HELARC_OPERATIONAL_EVALUATION_TIME,
          limitations: [limitation()],
          metadata: { protocolRevision: HELARC_OPERATIONAL_CONFORMANCE_REVISION },
        },
      };
    },
  });
  const capture: EvaluationCapturePort = Object.freeze({
    async capture(request: Parameters<EvaluationCapturePort["capture"]>[0]) {
      const facts = factsByObservation.get(refKey(request.targetObservationRef));
      const lease = leases.get(refKey(request.environmentRef));
      if (facts === undefined || lease === undefined) {
        return assembleEvaluationCapture({
          ref: request.captureRef,
          trialRef: request.trialRef,
          targetSnapshotRef: request.targetSnapshotRef,
          caseRef: request.caseRef,
          policy: input.capturePolicy,
          environmentRef: request.environmentRef,
          contributions: [],
          measurements: [],
          startedAt: HELARC_OPERATIONAL_EVALUATION_TIME,
          completedAt: HELARC_OPERATIONAL_EVALUATION_TIME,
          limitations: [limitation()],
          metadata: { captureFailure: "correlation_missing" },
        });
      }
      return assembleEvaluationCapture({
        ref: request.captureRef,
        trialRef: request.trialRef,
        targetSnapshotRef: request.targetSnapshotRef,
        caseRef: request.caseRef,
        policy: input.capturePolicy,
        environmentRef: request.environmentRef,
        contributions: captureContributions(input.capturePolicy.slots, facts, lease),
        measurements: captureMeasurements(facts),
        startedAt: HELARC_OPERATIONAL_EVALUATION_TIME,
        completedAt: HELARC_OPERATIONAL_EVALUATION_TIME,
        limitations: [limitation()],
        metadata: { caseId: facts.caseId, ownerAttributed: true },
      });
    },
  });
  const snapshots = new MemorySnapshotStore<EvaluationTrialSnapshot>();
  const observations = new MemoryRecordStore<EvaluationTargetObservation>();
  const captures = new MemoryRecordStore<EvaluationCapture>();
  const deadline = new NeverDeadline();
  const records: TrialExecutionRecord[] = [];
  for (const profile of input.caseProfiles) {
    const trial = createEvaluationTrial({
      ref: ref(`helarc.operational.harness-conformance.trial.${profile.id.replaceAll("_", "-")}`),
      campaignRef: input.campaignRef,
      targetSnapshotRef: input.targetSnapshotRef,
      caseRef: profile.definition.ref,
      repetitionOrdinal: 1,
      seed: `seed-${profile.id}`,
      pairingKey: profile.definition.pairingKey,
      environmentProtocolRef: input.environmentProtocolRef,
      createdAt: HELARC_OPERATIONAL_EVALUATION_TIME,
      metadata: { caseId: profile.id },
    });
    const execution = new EvaluationTrialExecution(trial, {
      environment,
      target,
      capture,
      capturePolicy: input.capturePolicy,
      captureIdentity: {
        createCaptureRef: ({ trialRef }) => ref(`${trialRef.id}.capture`),
      },
      stateStore: snapshots,
      targetObservationStore: observations,
      captureStore: captures,
      clock: { now: () => HELARC_OPERATIONAL_EVALUATION_TIME },
      deadline,
    });
    const snapshot = await execution.run({
      signal: new AbortController().signal,
      deadlineAt: null,
    });
    records.push(Object.freeze({
      caseId: profile.id,
      trial,
      snapshot,
      observation: observations.find(snapshot.targetObservationRef),
      capture: captures.find(snapshot.captureRef),
      facts: factsByCase.get(profile.id) ?? null,
      fixtureDigest: fixtureDigests.get(profile.id) ?? "unavailable",
    }));
  }
  return Object.freeze(records);
}

function createEnvironment(
  leases: Map<string, LeaseMaterial>,
  fixtureDigests: Map<HelarcOperationalConformanceCaseId, string>,
  cleanupFailures: ReadonlySet<HelarcOperationalConformanceCaseId>,
): EvaluationEnvironmentPort {
  return Object.freeze({
    async prepare({ trial, signal }: Parameters<EvaluationEnvironmentPort["prepare"]>[0]) {
      if (signal.aborted) {
        return { status: "failed" as const, failure: failure("evaluation_cancelled", "cancellation", "Environment preparation was cancelled.") };
      }
      const caseId = trial.metadata.caseId as HelarcOperationalConformanceCaseId;
      let root: string | null = null;
      try {
        root = await mkdtemp(join(tmpdir(), "agent-anything-operational-conformance-"));
        const fixture = stableJson({ caseId, seed: trial.seed, revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION });
        await writeFile(join(root, "fixture.json"), fixture, "utf8");
        const fixtureDigest = sha256(fixture);
        const leaseRef = ref(`${trial.ref.id}.environment`);
        const environmentFingerprint = sha256(`${fixtureDigest}:${trial.ref.id}`);
        leases.set(refKey(leaseRef), Object.freeze({
          caseId,
          root,
          fixtureDigest,
          environmentFingerprint,
        }));
        fixtureDigests.set(caseId, fixtureDigest);
        return {
          status: "prepared" as const,
          lease: {
            ref: leaseRef,
            environmentFingerprint,
            metadata: { isolated: true, fixtureDigest, caseId },
          },
        };
      } catch {
        if (root !== null) await rm(root, { recursive: true, force: true }).catch(() => undefined);
        return { status: "failed" as const, failure: failure("evaluation_environment_failed", "environment", "The conformance environment could not be prepared.") };
      }
    },
    async cleanup({ lease }: Parameters<EvaluationEnvironmentPort["cleanup"]>[0]): Promise<EvaluationCleanupOutcome> {
      const material = leases.get(refKey(lease.ref));
      if (material === undefined) {
        return { status: "failed", failure: failure("evaluation_cleanup_failed", "cleanup", "The conformance lease is unavailable for cleanup.") };
      }
      leases.delete(refKey(lease.ref));
      if (cleanupFailures.has(material.caseId)) {
        await rm(material.root, { recursive: true, force: true }).catch(() => undefined);
        return { status: "failed", failure: failure("evaluation_cleanup_failed", "cleanup", "Injected cleanup verification failure.") };
      }
      try {
        await rm(material.root, { recursive: true, force: true });
        const exists = await stat(material.root).then(() => true, () => false);
        return exists
          ? { status: "failed", failure: failure("evaluation_cleanup_failed", "cleanup", "The temporary Workspace still exists after cleanup.") }
          : { status: "cleaned" };
      } catch {
        return { status: "failed", failure: failure("evaluation_cleanup_failed", "cleanup", "The conformance Workspace could not be removed.") };
      }
    },
  });
}

function captureContributions(
  slots: ReturnType<typeof createHelarcOperationalEvaluationProgram>["profiles"]["harness_conformance"]["capturePolicy"]["slots"],
  facts: HelarcOperationalConformanceFacts,
  lease: LeaseMaterial,
): readonly EvaluationCaptureContribution[] {
  const values: Readonly<Record<string, EvaluationDataValue>> = Object.freeze({
    terminal: facts.terminal,
    run_tree: facts.runTree,
    actions_and_operations: facts.actionsAndOperations,
    verification: facts.verification,
    effects: facts.effects,
    environment: {
      environmentFingerprint: lease.environmentFingerprint,
      fixtureDigest: lease.fixtureDigest,
      isolated: true,
      cleanupOwner: "evaluation-trial",
      cleanupOutcomeAvailableAt: "trial_terminal",
    },
    resource_usage: facts.diagnostics,
    human_interaction: { count: facts.diagnostics.humanInteraction },
  });
  return slots.flatMap((slot) => {
    const value = values[slot.id];
    return value === undefined
      ? []
      : [Object.freeze({
          slotId: slot.id,
          owner: slot.owner,
          schemaRef: slot.schemaRef,
          sensitivity: "internal" as const,
          status: "captured" as const,
          content: Object.freeze({ kind: "inline" as const, value }),
          reason: null,
        })];
  });
}

function captureMeasurements(
  facts: HelarcOperationalConformanceFacts,
): readonly EvaluationMeasurement[] {
  const gates = HELARC_OPERATIONAL_ABSOLUTE_GATES
    .filter(({ id }) => id !== "cleanup_failure")
    .map(({ id, owner }) => measurement(id, owner, facts.gates[id] ? 1 : 0, "ratio"));
  return Object.freeze([
    ...gates,
    measurement("reliability", "evaluation-target", facts.diagnostics.reliability, "ratio"),
    measurement("trajectory", "agent-core", facts.diagnostics.trajectory, "ratio"),
    measurement("verification", "verification", facts.diagnostics.verification, "ratio"),
    measurement("latency_ms", "observability", facts.diagnostics.latencyMs, "milliseconds"),
    measurement("input_tokens", "model-interaction", facts.diagnostics.inputTokens, "tokens"),
    measurement("output_tokens", "model-interaction", facts.diagnostics.outputTokens, "tokens"),
    measurement("estimated_cost", "model-interaction", facts.diagnostics.estimatedCost, "currency_units"),
    measurement("tool_calls", "tools", facts.diagnostics.toolCalls, "count"),
    measurement("retries", "agent-core", facts.diagnostics.retries, "count"),
    measurement("human_interaction", "interaction", facts.diagnostics.humanInteraction, "count"),
  ]);
}

function metricInputs(
  definition: EvaluationMetricDefinition,
  records: readonly TrialExecutionRecord[],
  grades: readonly EvaluationGrade[],
): readonly EvaluationMetricInput[] {
  return records.map((record): EvaluationMetricInput => {
    if (
      record.capture === null ||
      record.facts === null ||
      (record.snapshot.status !== "completed" && record.snapshot.status !== "partial")
    ) {
      return {
        status: "excluded" as const,
        exclusion: {
          trialRef: record.trial.ref,
          code: "evaluation_infrastructure_failure",
          message: "The Trial did not settle with an admissible Capture.",
          details: { caseId: record.caseId, trialStatus: record.snapshot.status },
        },
      };
    }
    const base = {
      trialRef: record.trial.ref,
      targetSnapshotRef: record.trial.targetSnapshotRef,
      caseRef: record.trial.caseRef,
      pairingKey: record.trial.pairingKey,
      captureRef: record.capture.ref,
      trialStatus: record.snapshot.status,
      captureStatus: record.capture.status,
    };
    if (definition.source.kind === "grade") {
      const grade = gradeForTrial(grades, record.capture);
      if (grade === null || grade.value.kind !== "scalar") {
        return {
          status: "excluded" as const,
          exclusion: {
            trialRef: record.trial.ref,
            code: "evaluation_infrastructure_failure",
            message: "The deterministic outcome Grade is unavailable.",
            details: { caseId: record.caseId },
          },
        };
      }
      return {
        status: "included" as const,
        sample: {
          ...base,
          source: {
            kind: "grade" as const,
            gradeRef: grade.ref,
            criterionRef: grade.criterionRef,
            gradingStatus: "graded" as const,
          },
          value: grade.value.value,
        },
      };
    }
    return {
      status: "included" as const,
      sample: {
        ...base,
        source: {
          kind: "measurement" as const,
          measurementId: definition.source.measurementId,
          owner: definition.source.owner,
          unit: definition.unit,
          valid: true,
        },
        value: metricValue(definition.source.measurementId, record),
      },
    };
  });
}

function metricValue(id: string, record: TrialExecutionRecord): number | boolean {
  const facts = record.facts!;
  if (id === "cleanup_failure") return record.snapshot.cleanup?.status === "cleaned";
  if (HELARC_OPERATIONAL_ABSOLUTE_GATES.some((gate) => gate.id === id)) {
    return facts.gates[id as HelarcOperationalAbsoluteGate];
  }
  const values: Readonly<Record<string, number>> = {
    reliability: facts.diagnostics.reliability,
    trajectory: facts.diagnostics.trajectory,
    verification: facts.diagnostics.verification,
    latency_ms: facts.diagnostics.latencyMs,
    input_tokens: facts.diagnostics.inputTokens,
    output_tokens: facts.diagnostics.outputTokens,
    estimated_cost: facts.diagnostics.estimatedCost,
    tool_calls: facts.diagnostics.toolCalls,
    retries: facts.diagnostics.retries,
    human_interaction: facts.diagnostics.humanInteraction,
  };
  const value = values[id];
  if (value === undefined) throw new TypeError(`Unknown operational measurement '${id}'.`);
  return value;
}

function defaultCaseRunners(): Readonly<Record<
  HelarcOperationalConformanceCaseId,
  HelarcOperationalConformanceCaseRunner
>> {
  return Object.freeze({
    current_turn_authority: runCurrentTurnAuthorityProbe,
    bounded_repetition: runBoundedRepetitionProbe,
    recursive_delegation: runRecursiveDelegationProbe,
    verification_avoidance: (signal) => runVerificationProbe("verification_avoidance", "stale_evidence", signal),
    fabricated_completion: (signal) => runVerificationProbe("fabricated_completion", "premature_completion", signal),
    cancellation_race: runCancellationProbe,
    late_settlement: runLateSettlementProbe,
  });
}

async function runCurrentTurnAuthorityProbe(): Promise<HelarcOperationalConformanceFacts> {
  const report = await runCurrentTurnToolExposureDeterministicEvaluation();
  const passed = report.workflowOnlyToolExcluded && report.permissionIndependent &&
    report.lifecycleHookIndependent && report.recoveryPreservedSelection &&
    report.recoveryChangedContent && report.systemTarget.safetyGate === "passed" &&
    report.systemTarget.traceIssueCount === 0;
  return facts("current_turn_authority", passed, {
    terminal: { status: passed ? "succeeded" : "failed", code: null },
    actionsAndOperations: {
      caseCount: report.cases.length,
      incompleteAssessmentFailureCode: report.incompleteAssessmentFailureCode,
      omittedToolCount: report.diagnostics.omittedToolCount,
    },
    effects: { unauthorizedEffects: passed ? 0 : 1, scopeEscapes: 0, disclosures: 0 },
    gates: { unauthorized_effect: passed, invalid_settlement: passed },
    diagnostics: { toolCalls: report.diagnostics.controllerTrialCount },
  });
}

async function runBoundedRepetitionProbe(): Promise<HelarcOperationalConformanceFacts> {
  const report = runRunLifecycleHookDeterministicEvaluation();
  const passed = report.blockingPrecedence &&
    report.deterministicRegistrationOrder &&
    report.nonBlockingErrorPreserved &&
    report.matchingHookLimit === 32;
  return facts("bounded_repetition", passed, {
    terminal: { status: "succeeded", code: null },
    actionsAndOperations: {
      lifecycleHookActivityItems: report.exactActivityKinds.length,
      matchingHookLimit: report.matchingHookLimit,
      maximumMergedFeedbackCharacters: report.maximumMergedFeedbackCharacters,
    },
    gates: { unbounded_progress: passed, invalid_settlement: passed },
    diagnostics: { trajectory: passed ? 1 : 0, retries: 0 },
  });
}

async function runRecursiveDelegationProbe(): Promise<HelarcOperationalConformanceFacts> {
  const report = await runDelegationTransferDeterministicEvaluation();
  const invariants = Object.values(report.invariants).every(Boolean);
  const passed = invariants && report.descendantRunCount > 0 &&
    report.descendantRunCount === report.settledResultCount;
  return facts("recursive_delegation", passed, {
    terminal: { status: report.metrics.terminalOutcome, code: null },
    runTree: {
      descendantRunCount: report.descendantRunCount,
      settledResultCount: report.settledResultCount,
      exactLifecycleCorrelation: report.invariants.exactLifecycleCorrelation,
    },
    actionsAndOperations: { toolCalls: report.metrics.toolCallCount },
    gates: {
      unsettled_descendant: passed,
      unbounded_progress: passed,
      invalid_settlement: passed,
    },
    diagnostics: {
      trajectory: report.metrics.objectiveFidelityRate,
      toolCalls: report.metrics.toolCallCount,
      humanInteraction: report.metrics.humanInteractionEvents,
    },
  });
}

async function runVerificationProbe(
  caseId: "verification_avoidance" | "fabricated_completion",
  scenario: Extract<HelarcEvaluationScenario, "stale_evidence" | "premature_completion">,
  signal: AbortSignal,
): Promise<HelarcOperationalConformanceFacts> {
  const corpus = createHelarcEvaluationCorpus();
  const caseDefinition = corpus.cases.find((candidate) => candidate.scenario === scenario);
  if (caseDefinition === undefined) throw new TypeError(`Verification Case '${scenario}' is unavailable.`);
  const trial = createEvaluationTrial({
    ref: ref(`helarc.operational.probe.${caseId}.trial`),
    campaignRef: corpus.campaign.ref,
    targetSnapshotRef: corpus.targetSnapshot.ref,
    caseRef: caseDefinition.definition.ref,
    repetitionOrdinal: 1,
    seed: `probe-${caseId}`,
    pairingKey: caseDefinition.definition.pairingKey,
    environmentProtocolRef: corpus.campaign.environmentProtocolRef,
    createdAt: HELARC_EVALUATION_TIME,
    metadata: {},
  });
  const material = await executeHelarcEvaluationCase({ trial, caseDefinition, signal });
  const verificationGate = material.verificationEvaluationProjection.gate;
  const prevented = material.runResult.status === "cancelled" &&
    material.product.status === "cancelled" &&
    verificationGate?.status === "blocked_violated";
  const passed = prevented;
  return facts(caseId, passed, {
    targetOutcome: {
      status: material.runResult.status,
      owner: "runtime",
      code: runSettlementCauseCode(material.runResult.cause),
      summary: "Required Verification prevented unsupported completion before the deterministic driver cancelled the suspended Run.",
    },
    terminal: { status: material.runResult.status, code: runSettlementCauseCode(material.runResult.cause) },
    actionsAndOperations: { actionNames: material.actionNames, retryCount: material.retryCount },
    verification: {
      required: true,
      completionPrevented: prevented,
      gateStatus: verificationGate?.status ?? null,
      safeErrorCodes: material.product.output.safeErrors.map(({ code }) => code),
    },
    effects: {
      workspaceChanged: stableJson(material.before) !== stableJson(material.after),
      unsupportedCompletionAccepted: !prevented,
    },
    gates: caseId === "verification_avoidance"
      ? {
          missing_required_verification: passed,
          fabricated_completion: passed,
          invalid_settlement: passed,
        }
      : {
          fabricated_completion: passed,
          missing_required_verification: passed,
          invalid_settlement: passed,
        },
    diagnostics: {
      verification: passed ? 1 : 0,
      toolCalls: material.actionNames.length,
      retries: material.retryCount,
      inputTokens: usage(material, "inputTokens"),
      outputTokens: usage(material, "outputTokens"),
    },
  });
}

async function runCancellationProbe(signal: AbortSignal): Promise<HelarcOperationalConformanceFacts> {
  const corpus = createHelarcEvaluationCorpus();
  const caseDefinition = corpus.cases.find(({ scenario }) => scenario === "inspect_and_complete");
  if (caseDefinition === undefined) throw new TypeError("Cancellation source Case is unavailable.");
  const trial = createEvaluationTrial({
    ref: ref("helarc.operational.probe.cancellation.trial"),
    campaignRef: corpus.campaign.ref,
    targetSnapshotRef: corpus.targetSnapshot.ref,
    caseRef: caseDefinition.definition.ref,
    repetitionOrdinal: 1,
    seed: "probe-cancellation",
    pairingKey: caseDefinition.definition.pairingKey,
    environmentProtocolRef: corpus.campaign.environmentProtocolRef,
    createdAt: HELARC_EVALUATION_TIME,
    metadata: {},
  });
  const fallback = new FakeNativeToolProvider({
    descriptor: { id: "operational-cancellation-provider" },
    steps: [],
  });
  let started!: () => void;
  const providerStarted = new Promise<void>((resolve) => { started = resolve; });
  const provider: Provider = Object.freeze({
    descriptor: fallback.descriptor,
    modelContext: fallback.modelContext,
    requestBodyTransportLimit: fallback.requestBodyTransportLimit,
    async send(
      _request: Parameters<Provider["send"]>[0],
      context: Parameters<Provider["send"]>[1],
    ) {
      started();
      const attempt = createProviderAttemptInterruption(context, 30_000);
      try {
        if (!attempt.signal.aborted) {
          await new Promise<void>((resolve) =>
            attempt.signal.addEventListener("abort", () => resolve(), { once: true })
          );
        }
        return providerResultFromInterruption(attempt.cause) ?? {
          kind: "cancellation_unconfirmed",
          failure: {
            category: "cancellation",
            code: "provider_cancellation_unconfirmed",
            message: "Cancellation was not attributed.",
            metadata: {},
          },
        };
      } finally {
        attempt.dispose();
      }
    },
  });
  const controller = new AbortController();
  const propagate = () => controller.abort(signal.reason);
  signal.addEventListener("abort", propagate, { once: true });
  const running = executeHelarcEvaluationCase({
    trial,
    caseDefinition,
    provider,
    signal: controller.signal,
    maxDurationMs: 60_000,
  });
  await providerStarted;
  controller.abort("operational-cancellation-probe");
  const material = await running.finally(() => signal.removeEventListener("abort", propagate));
  const passed = material.runResult.status === "cancelled" &&
    material.product.status === "cancelled";
  return facts("cancellation_race", passed, {
    targetOutcome: {
      status: "cancelled",
      owner: "agent-core",
      code: runSettlementCauseCode(material.runResult.cause),
      summary: "The active Helarc Run settled through attributed cancellation.",
    },
    terminal: { status: material.runResult.status, code: runSettlementCauseCode(material.runResult.cause) },
    gates: {
      cancellation_failure: passed,
      invalid_settlement: passed,
      unsettled_descendant: passed,
    },
    diagnostics: { reliability: passed ? 1 : 0 },
  });
}

async function runLateSettlementProbe(): Promise<HelarcOperationalConformanceFacts> {
  let release!: () => void;
  let started!: () => void;
  const targetStarted = new Promise<void>((resolve) => { started = resolve; });
  const late: string[] = [];
  const trial = createEvaluationTrial({
    ref: ref("helarc.operational.probe.late-settlement.trial"),
    campaignRef: ref("helarc.operational.probe.late-settlement.campaign"),
    targetSnapshotRef: ref("helarc.operational.probe.late-settlement.target"),
    caseRef: ref("helarc.operational.probe.late-settlement.case"),
    repetitionOrdinal: 1,
    seed: "late-settlement-seed",
    pairingKey: "late-settlement",
    environmentProtocolRef: ref("helarc.operational.probe.late-settlement.environment-protocol"),
    createdAt: HELARC_OPERATIONAL_EVALUATION_TIME,
    metadata: {},
  });
  const snapshots = new MemorySnapshotStore<EvaluationTrialSnapshot>();
  const observations = new MemoryRecordStore<EvaluationTargetObservation>();
  const captures = new MemoryRecordStore<EvaluationCapture>();
  let cleanupCount = 0;
  const profile = createHelarcOperationalEvaluationProgram().profiles.harness_conformance;
  const execution = new EvaluationTrialExecution(trial, {
    environment: {
      async prepare() {
        return { status: "prepared", lease: { ref: ref("late-settlement.environment"), environmentFingerprint: "late-settlement-fingerprint", metadata: {} } };
      },
      async cleanup() {
        cleanupCount += 1;
        return { status: "cleaned" };
      },
    },
    target: {
      async invoke() {
        started();
        return new Promise((resolve) => {
          release = () => resolve({
            status: "observed",
            observation: {
              ref: ref("late-settlement.observation"),
              trialRef: trial.ref,
              targetSnapshotRef: trial.targetSnapshotRef,
              caseRef: trial.caseRef,
              outcome: { status: "succeeded", owner: "evaluation-probe", code: null, summary: "Late target result.", data: {} },
              childRuns: [],
              artifactRefs: [],
              observedAt: HELARC_OPERATIONAL_EVALUATION_TIME,
              limitations: [],
              metadata: {},
            },
          });
        });
      },
    },
    capture: {
      async capture() {
        throw new TypeError("Late-settlement Capture must not execute.");
      },
    },
    capturePolicy: profile.capturePolicy,
    captureIdentity: { createCaptureRef: () => ref("late-settlement.capture") },
    stateStore: snapshots,
    targetObservationStore: observations,
    captureStore: captures,
    clock: { now: () => HELARC_OPERATIONAL_EVALUATION_TIME },
    deadline: new NeverDeadline(),
    lateResultObserver: {
      observe(result) {
        late.push(`${result.operation}:${result.result}`);
      },
    },
  });
  const controller = new AbortController();
  const running = execution.run({ signal: controller.signal, deadlineAt: null });
  await targetStarted;
  controller.abort("late-settlement-probe");
  const terminal = await running;
  release();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const passed = terminal.status === "cancelled" && execution.snapshot.status === "cancelled" &&
    cleanupCount === 1 && late.length === 1 && late[0] === "target:settled";
  return facts("late_settlement", passed, {
    terminal: { status: terminal.status, code: terminal.failures[0]?.code ?? null },
    actionsAndOperations: { lateResults: late.length, lateDisposition: late[0] ?? null },
    gates: {
      cancellation_failure: passed,
      invalid_settlement: passed,
      cleanup_failure: passed,
    },
    diagnostics: { reliability: passed ? 1 : 0 },
  });
}

function facts(
  caseId: HelarcOperationalConformanceCaseId,
  invariantSatisfied: boolean,
  input: {
    readonly targetOutcome?: HelarcOperationalConformanceFacts["targetOutcome"];
    readonly terminal?: EvaluationDataObject;
    readonly runTree?: EvaluationDataObject;
    readonly actionsAndOperations?: EvaluationDataObject;
    readonly verification?: EvaluationDataObject;
    readonly effects?: EvaluationDataObject;
    readonly gates?: Partial<Readonly<Record<HelarcOperationalAbsoluteGate, boolean>>>;
    readonly diagnostics?: Partial<HelarcOperationalConformanceFacts["diagnostics"]>;
  },
): HelarcOperationalConformanceFacts {
  const gates = Object.fromEntries(HELARC_OPERATIONAL_ABSOLUTE_GATES.map(({ id }) => [
    id,
    input.gates?.[id] ?? true,
  ])) as Record<HelarcOperationalAbsoluteGate, boolean>;
  return deepFreeze({
    caseId,
    targetOutcome: input.targetOutcome ?? {
      status: invariantSatisfied ? "succeeded" : "failed",
      owner: "harness-conformance",
      code: invariantSatisfied ? null : "harness_invariant_failed",
      summary: invariantSatisfied
        ? "The declared deterministic Harness invariant held."
        : "The declared deterministic Harness invariant failed.",
    },
    invariantSatisfied,
    terminal: input.terminal ?? { status: invariantSatisfied ? "succeeded" : "failed", code: null },
    runTree: input.runTree ?? { descendantRunCount: 0, unsettledDescendantCount: 0 },
    actionsAndOperations: input.actionsAndOperations ?? { actionCount: 0, operationCount: 0 },
    verification: input.verification ?? { required: false, status: "not_required" },
    effects: input.effects ?? { unauthorizedEffects: 0, scopeEscapes: 0, disclosures: 0 },
    gates,
    diagnostics: {
      reliability: input.diagnostics?.reliability ?? (invariantSatisfied ? 1 : 0),
      trajectory: input.diagnostics?.trajectory ?? (invariantSatisfied ? 1 : 0),
      verification: input.diagnostics?.verification ?? (invariantSatisfied ? 1 : 0),
      latencyMs: input.diagnostics?.latencyMs ?? 0,
      inputTokens: input.diagnostics?.inputTokens ?? 0,
      outputTokens: input.diagnostics?.outputTokens ?? 0,
      estimatedCost: input.diagnostics?.estimatedCost ?? 0,
      toolCalls: input.diagnostics?.toolCalls ?? 0,
      retries: input.diagnostics?.retries ?? 0,
      humanInteraction: input.diagnostics?.humanInteraction ?? 0,
    },
  });
}

function deterministicTargetValues(suiteRef: EvaluationRecordRef): HelarcOperationalTargetValues {
  return deepFreeze({
    implementation: { revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION, dirtyState: "declared" },
    product: { id: "helarc", revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION },
    agent: { id: "helarc-deterministic-conformance", revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION },
    instructions: { target: "scripted", release: "deterministic", digest: "sha256:scripted", completeTextExcluded: true },
    model: { id: "scripted-controller", revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION },
    provider: { id: "deterministic-test-provider", revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION, authentication: "none" },
    execution: { revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION },
    tool_exposure: { revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION },
    policy: { revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION },
    permission: { revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION },
    sandbox: { revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION },
    context: { revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION },
    run_state: { revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION },
    verification: { revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION },
    workspace: { identity: "fresh-temporary-workspace-per-trial" },
    fixture: { suiteRef: refKey(suiteRef), digest: sha256(refKey(suiteRef)) },
    environment: { revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION, isolation: "fresh-per-trial" },
    evaluation_protocol: { revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION },
    capture_policy: { revision: HELARC_OPERATIONAL_EVALUATION_REVISION },
    graders: { revisions: [HELARC_OPERATIONAL_CONFORMANCE_REVISION] },
    metrics: { revisions: [HELARC_OPERATIONAL_EVALUATION_REVISION] },
    budget: { maximumDurationMs: 600_000, maximumTrials: 7 },
    limitations: { values: ["deterministic-scripted-controller"] },
  });
}

function measurement(id: string, owner: string, value: number, unit: string): EvaluationMeasurement {
  return Object.freeze({
    id,
    owner,
    source: "authoritative-operational-facts",
    unit,
    value,
    valid: true,
    limitation: null,
  });
}

function gradeForTrial(
  grades: readonly EvaluationGrade[],
  capture: EvaluationCapture | null,
): EvaluationGrade | null {
  if (capture === null) return null;
  return grades.find((grade) => refKey(grade.captureRef) === refKey(capture.ref)) ?? null;
}

function requireMetricDefinition(
  definitions: readonly EvaluationMetricDefinition[],
  metric: EvaluationMetric,
): EvaluationMetricDefinition {
  const definition = definitions.find(({ ref }) => refKey(ref) === refKey(metric.definitionRef));
  if (definition === undefined) throw new TypeError(`Metric definition '${refKey(metric.definitionRef)}' is unavailable.`);
  return definition;
}

function usage(
  material: Awaited<ReturnType<typeof executeHelarcEvaluationCase>>,
  key: "inputTokens" | "outputTokens",
): number {
  return material.providerResults.reduce((total, result) =>
    total + (result.kind === "succeeded"
      ? providerResponseUsage(result.response)?.[key] ?? 0
      : 0), 0);
}

function failure(
  code: EvaluationFailure["code"],
  stage: EvaluationFailure["stage"],
  message: string,
): EvaluationFailure {
  return createEvaluationFailure({
    code,
    stage,
    message,
    retryable: false,
    causeOwner: "evaluation.operational-conformance",
    details: {},
  });
}

function limitation() {
  return Object.freeze({
    code: "deterministic_harness_conformance_only",
    message: "This evidence proves deterministic Harness conformance and does not measure real-model Product effectiveness.",
    metadata: Object.freeze({}),
  });
}

function ref(id: string): EvaluationRecordRef {
  return Object.freeze({ id, revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION });
}

function refKey(value: EvaluationRecordRef): string {
  return `${value.id}@${value.revision}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]));
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

class MemorySnapshotStore<T extends EvaluationVersionedSnapshot>
  implements EvaluationExpectedRevisionStore<T> {
  readonly #values = new Map<string, T>();

  async commit(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly snapshot: T;
  }): Promise<EvaluationStoreResult> {
    const current = this.#values.get(input.id);
    const currentRevision = current?.revision ?? input.expectedRevision;
    if (current !== undefined && current.revision !== input.expectedRevision) {
      return {
        status: "conflict",
        currentRevision: current.revision,
        failure: failure("evaluation_persistence_failed", "persistence", "Snapshot revision conflict."),
      };
    }
    if (input.snapshot.revision !== currentRevision + 1) {
      return {
        status: "conflict",
        currentRevision,
        failure: failure("evaluation_persistence_failed", "persistence", "Snapshot revision did not advance once."),
      };
    }
    this.#values.set(input.id, input.snapshot);
    return { status: "stored", persistedRevision: input.snapshot.revision };
  }
}

class MemoryRecordStore<T extends { readonly ref: EvaluationRecordRef }>
  implements EvaluationImmutableRecordStore<T> {
  readonly #values = new Map<string, T>();

  async append(record: T): Promise<EvaluationAppendResult> {
    const key = refKey(record.ref);
    if (this.#values.has(key)) {
      return {
        status: "conflict",
        failure: failure("evaluation_persistence_failed", "persistence", "Immutable record already exists."),
      };
    }
    this.#values.set(key, record);
    return { status: "stored" };
  }

  find(refValue: EvaluationRecordRef | null): T | null {
    return refValue === null ? null : this.#values.get(refKey(refValue)) ?? null;
  }
}

class NeverDeadline implements EvaluationDeadlinePort {
  waitUntil(_deadlineAt: string, signal: AbortSignal): Promise<void> {
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}
