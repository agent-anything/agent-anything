import { describe, expect, it } from "vitest";

import type { EvaluationRecordRef } from "@agent-anything/evaluation/definition";

import {
  HELARC_OPERATIONAL_ABSOLUTE_GATES,
  createHelarcOperationalConformanceCases,
  createHelarcOperationalEvaluationProgram,
  type HelarcOperationalAbsoluteGate,
  type HelarcOperationalConformanceCaseId,
} from "./HelarcOperationalEvaluation.js";
import {
  gradeHelarcOperationalConformanceFacts,
  runHelarcOperationalConformance,
  type HelarcOperationalConformanceFacts,
} from "./HelarcOperationalConformanceExecution.js";
import {
  HELARC_CSHARP_CONSOLE_INCIDENT_CANDIDATE,
  evaluateCSharpConsoleIncidentCandidate,
  evaluateHelarcIncidentAdmission,
  type HelarcIncidentAdmissionEvidence,
} from "./HelarcIncidentAdmission.js";

describe("Helarc combined operational conformance", () => {
  it("defines one seven-Case hostile Suite and keeps cleanup as Trial-terminal truth", () => {
    const cases = createHelarcOperationalConformanceCases();
    const profile = createHelarcOperationalEvaluationProgram().profiles.harness_conformance;

    expect(cases.map(({ id }) => id)).toEqual([
      "current_turn_authority",
      "bounded_repetition",
      "recursive_delegation",
      "verification_avoidance",
      "fabricated_completion",
      "cancellation_race",
      "late_settlement",
    ]);
    expect(profile.suite.caseRefs).toHaveLength(cases.length);
    expect(HELARC_OPERATIONAL_ABSOLUTE_GATES).toHaveLength(10);
    expect(profile.capturePolicy.slots.some(({ id }) => id === "cleanup")).toBe(false);
    expect(profile.metrics.find((metric) =>
      metric.source.kind === "measurement" && metric.source.measurementId === "cleanup_failure"
    )?.source).toEqual({
      kind: "measurement",
      measurementId: "cleanup_failure",
      owner: "evaluation-trial",
    });
  });

  it("runs the real combined probes with isolated leases and all absolute gates", async () => {
    const result = await runHelarcOperationalConformance();

    expect(result.status, JSON.stringify({
      trials: result.trials.map((trial) => ({
        caseId: trial.caseId,
        status: trial.projection.status,
        gradePassed: trial.gradePassed,
        targetOutcomeStatus: trial.targetOutcomeStatus,
        failures: trial.infrastructureFailureCodes,
      })),
      gates: result.report.gateOutcomes.map((gate) => ({
        metric: gate.metricRef.id,
        status: gate.status,
        observedValue: gate.observedValue,
      })),
    }, null, 2)).toBe("passed");
    expect(result.trials).toHaveLength(7);
    expect(new Set(result.trials.map(({ environmentFingerprint }) => environmentFingerprint)).size)
      .toBe(7);
    expect(new Set(result.trials.map(({ fixtureDigest }) => fixtureDigest)).size).toBe(7);
    expect(result.trials.every(({ projection }) =>
      projection.status === "completed" && projection.cleanupStatus === "cleaned"
    )).toBe(true);
    expect(result.report.gateOutcomes).toHaveLength(11);
    expect(result.report.gateOutcomes.every(({ status }) => status === "passed")).toBe(true);
    expect(result.trials.find(({ caseId }) => caseId === "verification_avoidance")
      ?.targetOutcomeStatus).toBe("blocked");
    expect(result.trials.find(({ caseId }) => caseId === "cancellation_race")
      ?.targetOutcomeStatus).toBe("cancelled");
    expect(result.publication.failureCodes).toEqual([]);
  }, 180_000);

  it("fails Grader negative controls and cannot compensate a failed absolute gate", () => {
    const positive = fakeFacts("bounded_repetition");
    const negative = fakeFacts("bounded_repetition", {
      invariantSatisfied: false,
      failedGate: "unbounded_progress",
    });

    expect(gradeHelarcOperationalConformanceFacts(positive).criterionOutcome)
      .toBe("satisfied");
    expect(gradeHelarcOperationalConformanceFacts(negative)).toMatchObject({
      criterionOutcome: "not_satisfied",
      value: { kind: "scalar", value: 0, minimum: 0, maximum: 1, unit: "ratio" },
    });
  });

  it("keeps observed target non-success separate from invocation infrastructure failure", async () => {
    const targetFailure = await runHelarcOperationalConformance({
      caseRunners: allFakeRunners({
        current_turn_authority: async () => fakeFacts("current_turn_authority", {
          invariantSatisfied: false,
          targetStatus: "failed",
          failedGate: "unauthorized_effect",
        }),
      }),
    });
    const infrastructureFailure = await runHelarcOperationalConformance({
      caseRunners: allFakeRunners({
        current_turn_authority: async () => {
          throw new TypeError("Injected target adapter failure.");
        },
      }),
    });

    const observed = targetFailure.trials.find(({ caseId }) => caseId === "current_turn_authority")!;
    const unavailable = infrastructureFailure.trials.find(({ caseId }) => caseId === "current_turn_authority")!;
    expect(targetFailure.status).toBe("failed");
    expect(observed.projection.status).toBe("completed");
    expect(observed.targetOutcomeStatus).toBe("failed");
    expect(observed.infrastructureFailureCodes).toEqual([]);
    expect(infrastructureFailure.status).toBe("unavailable");
    expect(unavailable.projection.status).toBe("invocation_failed");
    expect(unavailable.targetOutcomeStatus).toBeNull();
    expect(unavailable.infrastructureFailureCodes).toContain("evaluation_invocation_failed");
  });

  it("fails the cleanup absolute gate without leaking Trial workspaces", async () => {
    const result = await runHelarcOperationalConformance({
      caseRunners: allFakeRunners(),
      cleanupFailureCaseIds: ["recursive_delegation"],
    });
    const affected = result.trials.find(({ caseId }) => caseId === "recursive_delegation")!;

    expect(result.status).toBe("failed");
    expect(affected.projection.status).toBe("partial");
    expect(affected.projection.cleanupStatus).toBe("failed");
    expect(affected.infrastructureFailureCodes).toContain("evaluation_cleanup_failed");
    expect(result.report.gateOutcomes.find(({ metricRef }) =>
      metricRef.id.includes("cleanup-failure")
    )?.status).toBe("failed");
    expect(JSON.stringify(result.publication)).not.toMatch(/[A-Z]:\\|\/tmp\//u);
  });
});

describe("Helarc incident admission", () => {
  it("retains the observed C# incident as a pending candidate", () => {
    const decision = evaluateCSharpConsoleIncidentCandidate();

    expect(decision.status).toBe("pending");
    expect(decision.reasonCodes).toEqual(expect.arrayContaining([
      "exact_reproduction_missing",
      "isolated_mechanism_missing",
      "minimized_case_missing",
      "fail_before_pass_after_missing",
    ]));
    expect(decision.admittedRegression).toBeNull();
    expect(Object.isFrozen(HELARC_CSHARP_CONSOLE_INCIDENT_CANDIDATE)).toBe(true);
  });

  it("rejects non-reproduction, language-specific mechanisms, unstable environments, and weak graders", () => {
    const evidence = completeAdmissionEvidence();
    const decision = evaluateHelarcIncidentAdmission({
      candidate: HELARC_CSHARP_CONSOLE_INCIDENT_CANDIDATE,
      evidence: {
        ...evidence,
        reproduction: { ...evidence.reproduction!, status: "not_reproduced" },
        mechanism: { ...evidence.mechanism!, languageNeutral: false },
        environment: {
          ...evidence.environment!,
          stable: false,
          fingerprints: ["environment-a", "environment-b"],
        },
        graderControl: { ...evidence.graderControl!, negativeControlPassed: false },
      },
    });

    expect(decision.status).toBe("rejected");
    expect(decision.reasonCodes).toEqual(expect.arrayContaining([
      "exact_target_not_reproduced",
      "mechanism_is_language_specific",
      "environment_not_stable",
      "grader_negative_control_failed",
    ]));
  });

  it("admits only a minimized language-neutral mechanism with fail-before/pass-after proof", () => {
    const evidence = completeAdmissionEvidence();
    const decision = evaluateHelarcIncidentAdmission({
      candidate: HELARC_CSHARP_CONSOLE_INCIDENT_CANDIDATE,
      evidence,
    });

    expect(decision.status).toBe("admitted");
    expect(decision.reasonCodes).toEqual([]);
    expect(decision.admittedRegression).toEqual({
      caseRef: evidence.minimization!.caseRef,
      suiteRef: evidence.placement!.suiteRef,
      owner: "agent-runtime.stop-review",
      failingReportRef: evidence.revisionProof!.failingReportRef,
      passingReportRef: evidence.revisionProof!.passingReportRef,
    });
  });
});

function fakeFacts(
  caseId: HelarcOperationalConformanceCaseId,
  options: {
    readonly invariantSatisfied?: boolean;
    readonly targetStatus?: "succeeded" | "failed" | "blocked" | "cancelled";
    readonly failedGate?: HelarcOperationalAbsoluteGate;
  } = {},
): HelarcOperationalConformanceFacts {
  const invariantSatisfied = options.invariantSatisfied ?? true;
  const gates = Object.fromEntries(HELARC_OPERATIONAL_ABSOLUTE_GATES.map(({ id }) => [
    id,
    id === options.failedGate ? false : true,
  ])) as Record<HelarcOperationalAbsoluteGate, boolean>;
  return Object.freeze({
    caseId,
    targetOutcome: Object.freeze({
      status: options.targetStatus ?? "succeeded",
      owner: "test-control",
      code: options.targetStatus === "failed" ? "harness_invariant_failed" : null,
      summary: "Deterministic test-control outcome.",
    }),
    invariantSatisfied,
    terminal: Object.freeze({ status: invariantSatisfied ? "succeeded" : "failed" }),
    runTree: Object.freeze({ descendantRunCount: 0, unsettledDescendantCount: 0 }),
    actionsAndOperations: Object.freeze({ actionCount: 0, operationCount: 0 }),
    verification: Object.freeze({ required: false, status: "not_required" }),
    effects: Object.freeze({ unauthorizedEffects: 0, scopeEscapes: 0, disclosures: 0 }),
    gates: Object.freeze(gates),
    diagnostics: Object.freeze({
      reliability: 1,
      trajectory: 1,
      verification: 1,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      toolCalls: 0,
      retries: 0,
      humanInteraction: 0,
    }),
  });
}

function allFakeRunners(
  overrides: Partial<Readonly<Record<
    HelarcOperationalConformanceCaseId,
    (signal: AbortSignal) => Promise<HelarcOperationalConformanceFacts>
  >>> = {},
) {
  return Object.fromEntries(createHelarcOperationalConformanceCases().map(({ id }) => [
    id,
    overrides[id] ?? (async () => fakeFacts(id)),
  ]));
}

function completeAdmissionEvidence(): HelarcIncidentAdmissionEvidence {
  return Object.freeze({
    reproduction: Object.freeze({
      status: "reproduced" as const,
      targetSnapshotRef: ref("target"),
      reportRef: ref("reproduction-report"),
    }),
    mechanism: Object.freeze({
      owner: "agent-runtime.stop-review",
      invariant: "Repeated unsupported Stop proposals terminate through bounded required feedback.",
      languageNeutral: true,
    }),
    minimization: Object.freeze({
      caseRef: ref("minimized-case"),
      fixtureDigest: "a".repeat(64),
      taskDigest: "b".repeat(64),
      trajectoryDigest: "c".repeat(64),
      expectedOutcomes: Object.freeze(["runtime_stop_feedback_exhausted"]),
      forbiddenOutcomes: Object.freeze(["unbounded_action_emission"]),
    }),
    environment: Object.freeze({
      protocolRef: ref("environment-protocol"),
      fingerprints: Object.freeze(["environment-a", "environment-a"]),
      stable: true,
    }),
    graderControl: Object.freeze({
      graderDefinitionRef: ref("grader"),
      negativeControlRef: ref("grader-negative-control"),
      negativeControlPassed: true,
    }),
    revisionProof: Object.freeze({
      failingImplementationRevision: "revision-before",
      failingReportRef: ref("report-before"),
      passingImplementationRevision: "revision-after",
      passingReportRef: ref("report-after"),
      failedBefore: true,
      passedAfter: true,
    }),
    placement: Object.freeze({
      suiteRef: ref("permanent-regression-suite"),
      lifecycle: "permanent_regression" as const,
      owner: "agent-runtime.stop-review",
      limitations: Object.freeze(["Deterministic language-neutral mechanism only."]),
    }),
  });
}

function ref(id: string): EvaluationRecordRef {
  return Object.freeze({ id, revision: "test-v1" });
}
