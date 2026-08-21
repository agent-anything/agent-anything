import { describe, expect, it } from "vitest";

import {
  createHelarcProductEffectivenessObjective,
  createHelarcProductEffectivenessTargetSnapshot,
  HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL,
  HELARC_PRODUCT_EFFECTIVENESS_TARGET_INPUTS,
  type HelarcProductEffectivenessTargetValues,
} from "./HelarcProductEffectivenessProtocol.js";

const TIME = "2026-08-21T00:00:00.000Z";

describe("Helarc Product-effectiveness Evaluation protocol", () => {
  it("creates comparable immutable Codex and Helarc Target Snapshots", () => {
    const objective = createHelarcProductEffectivenessObjective({
      ref: ref("objective"),
      outcomeCriterionRef: ref("outcome-criterion"),
      qualityGateRef: ref("quality-gate"),
      safetyGateRefs: HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates.map(ref),
      createdAt: TIME,
    });
    const codex = createHelarcProductEffectivenessTargetSnapshot({
      ref: ref("codex-snapshot"),
      targetRef: ref("codex-target"),
      objective,
      targetName: "codex",
      sourceRevision: "codex-reference-1",
      values: targetValues("codex"),
      createdAt: TIME,
    });
    const helarc = createHelarcProductEffectivenessTargetSnapshot({
      ref: ref("helarc-snapshot"),
      targetRef: ref("helarc-target"),
      objective,
      targetName: "helarc",
      sourceRevision: "helarc-candidate-1",
      values: targetValues("helarc"),
      createdAt: TIME,
    });

    expect(codex.objectiveRef).toEqual(helarc.objectiveRef);
    expect(codex.manifest.map((item) => item.key)).toEqual(
      helarc.manifest.map((item) => item.key),
    );
    expect(codex.manifest).toHaveLength(HELARC_PRODUCT_EFFECTIVENESS_TARGET_INPUTS.length);
    expect(Object.isFrozen(codex)).toBe(true);
    expect(Object.isFrozen(helarc)).toBe(true);
  });

  it("keeps outcome threshold, absolute safety, and diagnostic metrics separate", () => {
    expect(HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL).toMatchObject({
      minimumPairedTrialsPerTargetCase: 3,
      minimumWeightedOutcomeRatio: 0.6,
      scriptedProviderOutputAdmissible: false,
      excludedTrialHandling: "explicit",
      incomparableTrialHandling: "explicit",
    });
    expect(HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates).toContain(
      "unauthorized_effect",
    );
    expect(HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.diagnosticMetrics).toEqual(
      expect.arrayContaining(["trajectory", "validation", "human_attention"]),
    );
  });
});

function targetValues(targetName: "codex" | "helarc"): HelarcProductEffectivenessTargetValues {
  return {
    product: { targetName, version: "1" },
    agent: { identity: `${targetName}-agent` },
    prompt: { revision: "prompt-1" },
    model: { id: "declared-model", revision: "1" },
    provider: { id: "declared-provider", revision: "1" },
    tool_catalog: { revision: "tool-catalog-1" },
    environment: { fixture: "repository-fixture-1" },
    settings: { revision: "settings-1" },
    permission: { preset: "ask" },
    budget: { maximumDurationMs: 300_000, maximumOperations: 100 },
    limitations: { items: [] },
  };
}

function ref(id: string) {
  return { id, revision: "1" };
}
