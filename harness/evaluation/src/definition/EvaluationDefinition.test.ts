import { describe, expect, it } from "vitest";
import {
  EvaluationContractError,
  createEvaluationCase,
  createEvaluationFailure,
  createEvaluationObjective,
  createEvaluationSuite,
  createEvaluationTargetSnapshot,
  snapshotEvaluationData,
  type EvaluationCase,
  type EvaluationObjective,
} from "./index.js";

const CREATED_AT = "2026-08-01T00:00:00.000Z";

describe("Evaluation definitions", () => {
  it("rejects invalid Objective and Case contracts before execution", () => {
    const objective = createObjective();
    const caseDefinition = createCase("case", "regression", "internal");

    expect(() => createEvaluationObjective({
      ...objective,
      name: "",
    })).toThrow(/name/);
    expect(() => createEvaluationObjective({
      ...objective,
      dimensions: [],
    })).toThrow(/dimensions/);
    expect(() => createEvaluationCase({
      ...caseDefinition,
      budget: { ...caseDefinition.budget, maximumDurationMs: 0 },
    })).toThrow(/maximumDurationMs/);
    expect(() => createEvaluationCase({
      ...caseDefinition,
      graderRefs: [],
    })).toThrow(/graderRefs/);
  });

  it("snapshots JSON-safe values canonically and rejects mutable object kinds", () => {
    const source = { z: [1, { ok: true }], a: "value" };
    const snapshot = snapshotEvaluationData(source);

    expect(snapshot).toEqual({ a: "value", z: [1, { ok: true }] });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => snapshotEvaluationData(new Date())).toThrow(EvaluationContractError);
    expect(() => snapshotEvaluationData({ value: Number.NaN })).toThrow(/non-finite/);
  });

  it("rejects sensitive details from Evaluation failures", () => {
    const createFailure = (details: Record<string, string>) => createEvaluationFailure({
      code: "evaluation_invocation_failed",
      stage: "invocation",
      message: "Invocation failed.",
      retryable: false,
      causeOwner: "evaluation.target",
      details,
    });

    expect(() => createFailure({ apiKey: "secret" })).toThrow(/apiKey/);
    expect(() => createFailure({ rootPath: "D:/private/workspace" })).toThrow(/rootPath/);
  });

  it("admits only complete exact Target Snapshot manifests", () => {
    const objective = createObjective();
    const snapshot = createEvaluationTargetSnapshot({
      ref: ref("target-snapshot"),
      objectiveRef: objective.ref,
      targetRef: ref("helarc-target"),
      manifest: [
        {
          key: "agent.revision",
          owner: "agent",
          required: true,
          sourceRevision: "r1",
          schemaRef: schema("agent-revision"),
          status: "captured",
          representation: { kind: "fingerprint", fingerprint: "sha256:agent" },
          sensitivity: "public",
          disclosure: "public",
          limitation: null,
        },
        {
          key: "verification.summary",
          owner: "verification",
          required: false,
          sourceRevision: "unavailable-v1",
          schemaRef: schema("verification-summary"),
          status: "unavailable",
          representation: null,
          sensitivity: "internal",
          disclosure: "internal",
          limitation: limitation("verification_unavailable"),
        },
      ],
      createdAt: CREATED_AT,
      metadata: {},
      limitations: [],
    }, objective);

    expect(snapshot.manifest.map((item) => item.key)).toEqual([
      "agent.revision",
      "verification.summary",
    ]);
    expect(Object.isFrozen(snapshot.manifest)).toBe(true);

    expect(() => createEvaluationTargetSnapshot({
      ...snapshot,
      ref: ref("incomplete"),
      manifest: [snapshot.manifest[0]],
    }, objective)).toThrow(/missing 'verification.summary'/);
    expect(() => createEvaluationTargetSnapshot({
      ...snapshot,
      ref: ref("over-disclosed"),
      manifest: snapshot.manifest.map((entry) => entry.key === "verification.summary"
        ? { ...entry, disclosure: "public" as const }
        : entry),
    }, objective)).toThrow(/disclosure/);
    expect(() => createEvaluationTargetSnapshot({
      ...snapshot,
      ref: ref("unsafe-value"),
      manifest: snapshot.manifest.map((entry) => entry.key === "agent.revision"
        ? {
            ...entry,
            representation: {
              kind: "value" as const,
              value: { rootPath: "D:/private/workspace" },
            },
          }
        : entry),
    }, objective)).toThrow(/rootPath/);
  });

  it("keeps corpus purpose independent from visibility and resolves exact Case refs", () => {
    const regression = createCase("case-regression", "regression", "private");
    const benchmark = createCase("case-benchmark", "benchmark", "public");
    const suite = createEvaluationSuite({
      ref: ref("suite"),
      name: "Suite",
      caseRefs: [benchmark.ref, regression.ref],
      distribution: { kind: "declared" },
      selectionRules: { include: "all" },
      validity: { validFrom: CREATED_AT, validUntil: null },
      provenance: provenance(),
      supersedes: null,
      createdAt: CREATED_AT,
      metadata: {},
      limitations: [],
    }, [regression, benchmark]);

    expect(regression.partition).toEqual({ purpose: "regression", visibility: "private" });
    expect(suite.caseRefs.map((item) => item.id)).toEqual([
      "case-benchmark",
      "case-regression",
    ]);
    expect(() => createEvaluationSuite(
      { ...suite, ref: ref("bad-suite"), caseRefs: [ref("unknown")] },
      [regression, benchmark],
    )).toThrow(/not admitted/);
  });
});

function createObjective(): EvaluationObjective {
  return createEvaluationObjective({
    ref: ref("objective"),
    name: "Objective",
    decision: "Detect behavior regressions.",
    dimensions: ["safety", "outcome_quality"],
    criterionRefs: [ref("criterion")],
    qualityGateRefs: [ref("quality-gate")],
    safetyGateRefs: [ref("safety-gate")],
    behaviorInputRequirements: [
      {
        key: "agent.revision",
        owner: "agent",
        required: true,
        schemaRef: schema("agent-revision"),
        maximumSensitivity: "public",
        description: "Exact Agent revision.",
      },
      {
        key: "verification.summary",
        owner: "verification",
        required: false,
        schemaRef: schema("verification-summary"),
        maximumSensitivity: "internal",
        description: "Optional Verification summary.",
      },
    ],
    suiteConstraints: {},
    comparisonBasis: { requireExactTarget: true },
    acceptableExclusionCodes: [],
    createdAt: CREATED_AT,
    metadata: {},
    limitations: [],
  });
}

function createCase(
  id: string,
  purpose: EvaluationCase["partition"]["purpose"],
  visibility: EvaluationCase["partition"]["visibility"],
): EvaluationCase {
  return createEvaluationCase({
    ref: ref(id),
    name: id,
    targetInput: { task: "inspect" },
    fixtureRefs: [ref("fixture")],
    expectedClaimRefs: [ref("claim")],
    criterionRefs: [ref("criterion")],
    graderRefs: [ref("grader")],
    budget: {
      maximumDurationMs: 10_000,
      maximumCost: null,
      maximumTokens: 1_000,
      maximumOperations: 10,
    },
    distributionKey: "default",
    pairingKey: "pair-1",
    partition: { purpose, visibility },
    provenance: provenance(),
    validity: { validFrom: CREATED_AT, validUntil: null },
    supersedes: null,
    createdAt: CREATED_AT,
    metadata: {},
    limitations: [],
  });
}

function ref(id: string) {
  return { id, revision: "v1" };
}

function schema(id: string) {
  return { schemaId: id, revision: "v1" };
}

function limitation(code: string) {
  return { code, message: code, metadata: {} };
}

function provenance() {
  return { source: "repository", sourceRevision: "r1", license: "Apache-2.0", metadata: {} };
}
