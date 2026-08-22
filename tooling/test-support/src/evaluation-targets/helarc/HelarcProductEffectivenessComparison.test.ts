import { describe, expect, it } from "vitest";

import {
  createHelarcProductEffectivenessObjective,
  createHelarcProductEffectivenessTargetSnapshot,
  HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL,
  type HelarcProductEffectivenessTargetValues,
} from "./HelarcProductEffectivenessProtocol.js";
import {
  createHelarcProductEffectivenessSuite,
  HELARC_PRODUCT_EFFECTIVENESS_REPETITIONS,
  HELARC_PRODUCT_EFFECTIVENESS_TIME,
} from "./HelarcProductEffectivenessSuite.js";
import {
  importHelarcProductEffectivenessEvidenceBundle,
  sealHelarcProductEffectivenessEvidenceBundle,
  type HelarcProductEffectivenessEvidenceBundle,
  type HelarcProductEffectivenessSafetyGate,
  type HelarcProductEffectivenessTargetName,
  type HelarcProductEffectivenessTrialEvidence,
} from "./HelarcProductEffectivenessEvidence.js";
import { compareHelarcProductEffectiveness } from "./HelarcProductEffectivenessComparison.js";

describe("Helarc Product-effectiveness Evidence and comparison", () => {
  it("seals and imports immutable evidence with exact content digests", () => {
    const fixture = createComparisonFixture();
    const bundle = createBundle(fixture, "codex", 1);
    const imported = importHelarcProductEffectivenessEvidenceBundle({
      json: JSON.stringify(bundle),
      objective: fixture.objective,
      suite: fixture.suite,
    });

    expect(imported).toEqual(bundle);
    expect(imported.bundleDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(imported.trials).toHaveLength(
      fixture.suite.cases.length * HELARC_PRODUCT_EFFECTIVENESS_REPETITIONS,
    );
    expect(Object.isFrozen(imported)).toBe(true);
  });

  it("rejects fabricated scripted-provider evidence and modified imports", () => {
    const fixture = createComparisonFixture();
    const bundle = createBundle(fixture, "helarc", 0.7);
    const scripted = structuredClone(bundle);
    (scripted.trials[0]!.provenance as { scriptedProviderOutput: boolean })
      .scriptedProviderOutput = true;

    expect(() => sealHelarcProductEffectivenessEvidenceBundle({
      objective: fixture.objective,
      suite: fixture.suite,
      bundle: withoutSealedFields(scripted),
    })).toThrow(/scripted Provider output/);

    const modified = structuredClone(bundle);
    (modified.trials[0] as { outcomeScore: number | null }).outcomeScore = 0;
    expect(() => importHelarcProductEffectivenessEvidenceBundle({
      json: JSON.stringify(modified),
      objective: fixture.objective,
      suite: fixture.suite,
    })).toThrow(/digest/);
  });

  it("passes only complete safe evidence at or above the weighted outcome ratio", () => {
    const fixture = createComparisonFixture();
    const comparison = compareHelarcProductEffectiveness({
      suite: fixture.suite,
      codex: createBundle(fixture, "codex", 1),
      helarc: createBundle(fixture, "helarc", 0.7),
      reportRef: ref("helarc.product-effectiveness.report.accepted"),
      campaignRef: ref("helarc.product-effectiveness.campaign"),
      createdAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
    });

    expect(comparison).toMatchObject({
      releaseStatus: "passed",
      comparablePairCount: 18,
      requiredPairCount: 18,
    });
    expect(comparison.outcomeRatio).toBeCloseTo(0.7);
    expect(comparison.report.intent).toBe("comparison");
    expect(comparison.report.gateOutcomes.every((item) => item.status === "passed")).toBe(true);
    expect(comparison.diagnostics.helarc.reliability).toBe(1);
    expect(comparison.diagnostics.helarc.trajectory).toBeCloseTo(0.8);
    expect(comparison.diagnostics.helarc.validation).toBe(1);
  });

  it("fails the ratio and absolute safety gates independently", () => {
    const fixture = createComparisonFixture();
    const belowThreshold = compareFixture(
      fixture,
      createBundle(fixture, "helarc", 0.5),
    );
    expect(belowThreshold.releaseStatus).toBe("failed");
    expect(belowThreshold.releaseReason).toMatch(/below/);

    const unsafe = createBundle(fixture, "helarc", 0.9, {
      unsafeGate: "scope_escape",
    });
    const unsafeComparison = compareFixture(fixture, unsafe);
    expect(unsafeComparison.releaseStatus).toBe("failed");
    expect(unsafeComparison.safety.scope_escape).toBe("failed");
    expect(unsafeComparison.releaseReason).toMatch(/safety/);
  });

  it("keeps incomplete or excluded paired coverage unavailable instead of scoring it as zero", () => {
    const fixture = createComparisonFixture();
    const incomplete = createBundle(fixture, "helarc", 0.9, { omitLastTrial: true });
    const comparison = compareFixture(fixture, incomplete);

    expect(comparison.releaseStatus).toBe("unavailable");
    expect(comparison.comparablePairCount).toBe(17);
    expect(comparison.outcomeRatio).toBeNull();
    expect(comparison.exclusions).toHaveLength(1);
    expect(comparison.report.comparability.status).toBe("incomparable");
  });
});

function createComparisonFixture() {
  const suite = createHelarcProductEffectivenessSuite();
  const objective = createHelarcProductEffectivenessObjective({
    ref: ref("helarc.product-effectiveness.objective"),
    outcomeCriterionRef: ref("helarc.product-effectiveness.criterion.outcome"),
    qualityGateRef: ref("helarc.product-effectiveness.metric.outcome-ratio"),
    safetyGateRefs: HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates.map((gate) =>
      ref(`helarc.product-effectiveness.metric.safety.${gate}`)),
    createdAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
  });
  const snapshots = {
    codex: createHelarcProductEffectivenessTargetSnapshot({
      ref: ref("helarc.product-effectiveness.target-snapshot.codex"),
      targetRef: ref("codex.product"),
      objective,
      targetName: "codex",
      sourceRevision: "codex-reference-v1",
      values: targetValues("codex"),
      createdAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
    }),
    helarc: createHelarcProductEffectivenessTargetSnapshot({
      ref: ref("helarc.product-effectiveness.target-snapshot.helarc"),
      targetRef: ref("helarc.product"),
      objective,
      targetName: "helarc",
      sourceRevision: "helarc-candidate-v1",
      values: targetValues("helarc"),
      createdAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
    }),
  };
  return Object.freeze({ suite, objective, snapshots });
}

function createBundle(
  fixture: ReturnType<typeof createComparisonFixture>,
  targetName: HelarcProductEffectivenessTargetName,
  outcomeScore: number,
  options: {
    readonly unsafeGate?: HelarcProductEffectivenessSafetyGate;
    readonly omitLastTrial?: boolean;
  } = {},
): HelarcProductEffectivenessEvidenceBundle {
  const trials = fixture.suite.cases.flatMap((profile) =>
    Array.from({ length: HELARC_PRODUCT_EFFECTIVENESS_REPETITIONS }, (_, index) => {
      const repetitionOrdinal = index + 1;
      const safety = Object.fromEntries(
        HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates.map((gate) => [
          gate,
          options.unsafeGate === gate && profile.id === "repository-investigation" &&
            repetitionOrdinal === 1 ? false : true,
        ]),
      ) as Record<HelarcProductEffectivenessSafetyGate, boolean>;
      return {
        ref: ref(`${targetName}.trial.${profile.id}.${repetitionOrdinal}`),
        targetName,
        targetSnapshotRef: fixture.snapshots[targetName].ref,
        suiteRef: fixture.suite.suite.ref,
        caseRef: profile.definition.ref,
        repetitionOrdinal,
        pairingKey: `${profile.definition.pairingKey}.rep-${repetitionOrdinal}`,
        status: "completed",
        outcomeScore,
        safety,
        diagnostics: {
          trajectoryScore: 0.8,
          validationScore: 1,
          latencyMs: targetName === "codex" ? 1_000 : 1_200,
          inputTokens: 100,
          outputTokens: 50,
          toolCalls: 3,
          humanAttentionEvents: profile.id === "clarification" ? 1 : 0,
        },
        exclusion: null,
        provenance: {
          executionSource: targetName === "codex" ? "imported" : "captured",
          productVersion: `${targetName}-v1`,
          model: `${targetName}-model-v1`,
          environment: "evaluation-environment-v1",
          graderKind: "reference",
          graderRevision: profile.graderRevision,
          capturedAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
          sourceArtifactDigest: `sha256:${(targetName === "codex" ? "a" : "b").repeat(64)}`,
          scriptedProviderOutput: false,
          metadata: { fixture: profile.fixtureRevision },
        },
        limitations: [],
      } satisfies HelarcProductEffectivenessTrialEvidence;
    }));
  if (options.omitLastTrial) trials.pop();
  return sealHelarcProductEffectivenessEvidenceBundle({
    objective: fixture.objective,
    suite: fixture.suite,
    bundle: {
      targetName,
      targetSnapshot: fixture.snapshots[targetName],
      suiteRef: fixture.suite.suite.ref,
      trials,
      createdAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
      limitations: ["Synthetic fixture evidence is protocol-test data only."],
    },
  });
}

function compareFixture(
  fixture: ReturnType<typeof createComparisonFixture>,
  helarc: HelarcProductEffectivenessEvidenceBundle,
) {
  return compareHelarcProductEffectiveness({
    suite: fixture.suite,
    codex: createBundle(fixture, "codex", 1),
    helarc,
    reportRef: ref("helarc.product-effectiveness.report.candidate"),
    campaignRef: ref("helarc.product-effectiveness.campaign"),
    createdAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
  });
}

function withoutSealedFields(bundle: HelarcProductEffectivenessEvidenceBundle) {
  return {
    targetName: bundle.targetName,
    targetSnapshot: bundle.targetSnapshot,
    suiteRef: bundle.suiteRef,
    trials: bundle.trials,
    createdAt: bundle.createdAt,
    limitations: bundle.limitations,
  };
}

function targetValues(targetName: HelarcProductEffectivenessTargetName): HelarcProductEffectivenessTargetValues {
  return {
    product: { targetName, version: "v1" },
    agent: { identity: `${targetName}-agent-v1` },
    prompt: { revision: `${targetName}-instructions-v1` },
    model: { id: `${targetName}-model`, revision: "v1" },
    provider: { id: `${targetName}-provider`, revision: "v1" },
    tool_catalog: { revision: `${targetName}-tool-catalog-v1` },
    environment: { fixture: "product-effectiveness-environment-v1" },
    settings: { revision: `${targetName}-settings-v1` },
    permission: { preset: "ask" },
    budget: { maximumDurationMs: 300_000, maximumOperations: 100 },
    limitations: { items: [] },
  };
}

function ref(id: string) {
  return Object.freeze({ id, revision: "v1" });
}
