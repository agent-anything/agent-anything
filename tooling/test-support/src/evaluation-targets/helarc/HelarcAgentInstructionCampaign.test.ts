import { describe, expect, it } from "vitest";

import {
  FakeNativeToolProvider,
  fakeNativeModelOutput,
} from "../../provider/FakeNativeToolProvider.js";
import {
  createHelarcAgentInstructionCampaignArtifact,
  createHelarcAgentInstructionCampaignUnavailableArtifact,
  verifyHelarcAgentInstructionCampaignArtifact,
} from "./HelarcAgentInstructionCampaign.js";
import { captureHelarcProductEffectiveness } from "./HelarcProductEffectivenessCapture.js";
import { createHelarcProductEffectivenessDefinition } from "./HelarcProductEffectivenessDefinition.js";
import {
  createHelarcProductEffectivenessTargetSnapshot,
  createHelarcProductEffectivenessTargetValues,
} from "./HelarcProductEffectivenessProtocol.js";
import { HELARC_PRODUCT_EFFECTIVENESS_TIME } from "./HelarcProductEffectivenessSuite.js";

describe("Helarc real-model Agent instruction Campaign", () => {
  it("produces separate minimal, production, and paired Reports", async () => {
    const fixture = createFixture();
    const [minimal, production] = await Promise.all([
      capture(fixture, "minimal", "fake-model"),
      capture(fixture, "production", "fake-model"),
    ]);
    const artifact = createHelarcAgentInstructionCampaignArtifact({
      objective: fixture.definition.objective,
      suite: fixture.suite,
      minimal,
      production,
      createdAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
    });

    expect(artifact.disposition).toEqual({ status: "comparable" });
    expect(artifact.reports.minimal).toMatchObject({
      instructionTarget: "minimal",
      status: "passed",
      requiredTrialCount: 3,
      completedTrialCount: 3,
    });
    expect(artifact.reports.production).toMatchObject({
      instructionTarget: "production",
      status: "passed",
      requiredTrialCount: 3,
      completedTrialCount: 3,
    });
    expect(artifact.reports.comparison.report.intent).toBe("comparison");
    expect(artifact.reports.comparison.report.comparability.status).toBe("comparable");
    expect(artifact.reports.comparison.report.gateOutcomes.every(({ status }) =>
      status === "passed"
    )).toBe(true);
    expect(artifact.reports.minimal.report.metricSummaries.some(({ metricRef }) =>
      metricRef.id.includes("retries")
    )).toBe(true);
    expect(artifact.reports.minimal.report.metricSummaries.some(({ metricRef }) =>
      metricRef.id.includes("estimatedCost")
    )).toBe(true);
    expect(JSON.stringify({
      minimal: artifact.reports.minimal.publication,
      production: artifact.reports.production.publication,
      comparison: artifact.reports.comparison.publication,
    })).not.toMatch(/api[_ -]?key|fullinstructions|instructiontext|[A-Z]:\\|\/tmp\//iu);
    expect(artifact.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(verifyHelarcAgentInstructionCampaignArtifact(structuredClone(artifact)))
      .toMatchObject({ digest: artifact.digest });

    const tampered = structuredClone(artifact);
    Object.assign(tampered, { digest: `sha256:${"0".repeat(64)}` });
    expect(() => verifyHelarcAgentInstructionCampaignArtifact(tampered))
      .toThrow("digest does not match");
  }, 120_000);

  it("marks a changed non-instruction target incomparable and configuration absence unavailable", async () => {
    const fixture = createFixture();
    const [minimal, production] = await Promise.all([
      capture(fixture, "minimal", "fake-model"),
      capture(fixture, "production", "different-model"),
    ]);
    const artifact = createHelarcAgentInstructionCampaignArtifact({
      objective: fixture.definition.objective,
      suite: fixture.suite,
      minimal,
      production,
      createdAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
    });
    const unavailable = createHelarcAgentInstructionCampaignUnavailableArtifact({
      code: "evaluation_configuration_unavailable",
      reason: "Real-model configuration is incomplete.",
      missingConfiguration: ["MODEL", "PROVIDER", "MODEL"],
      createdAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
    });

    expect(artifact.disposition).toMatchObject({
      status: "incomparable",
      code: "non_instruction_input_mismatch",
    });
    expect(artifact.reports.comparison.report.comparability.status).toBe("incomparable");
    expect(artifact.reports.comparison.report.dimensionSummaries.every(({ interpretation }) =>
      interpretation === "unavailable"
    )).toBe(true);
    expect(unavailable).toMatchObject({
      disposition: { status: "unavailable", code: "evaluation_configuration_unavailable" },
      missingConfiguration: ["MODEL", "PROVIDER"],
      evidence: null,
      reports: null,
    });
    expect(verifyHelarcAgentInstructionCampaignArtifact(structuredClone(unavailable)))
      .toMatchObject({ digest: unavailable.digest });
  }, 120_000);
});

function createFixture() {
  const definition = createHelarcProductEffectivenessDefinition();
  const caseProfile = definition.suite.cases.find(({ id }) =>
    id === "repository-investigation"
  )!;
  return Object.freeze({
    definition,
    suite: Object.freeze({
      ...definition.suite,
      cases: Object.freeze([caseProfile]),
    }),
  });
}

async function capture(
  fixture: ReturnType<typeof createFixture>,
  instructionTarget: "minimal" | "production",
  model: string,
) {
  return await captureHelarcProductEffectiveness({
    objective: fixture.definition.objective,
    suite: fixture.suite,
    targetSnapshot: createHelarcProductEffectivenessTargetSnapshot({
      ref: ref(`target.${instructionTarget}.${model}`),
      targetRef: ref("helarc.product"),
      objective: fixture.definition.objective,
      targetName: "helarc",
      sourceRevision: "campaign-test-source-v1",
      values: createHelarcProductEffectivenessTargetValues({
        instructionTarget,
        sourceRevision: "campaign-test-source-v1",
        sourceDirtyState: "clean",
        sourceTreeDigest: `sha256:${"a".repeat(64)}`,
        packageRevisions: { "@agent-anything/helarc": "campaign-test-product-v1" },
        productVersion: "campaign-test-product-v1",
        providerId: "campaign-test-provider",
        providerKind: "fake",
        providerRevision: "campaign-test-provider-v1",
        providerEndpoint: "memory://campaign-test-provider",
        providerAuthentication: "none",
        modelId: model,
        modelRevision: `${model}-v1`,
        environmentId: "campaign-test-environment",
        providerTimeoutMs: 120_000,
        maximumInputBytes: 1_048_576,
        sandboxEnforcement: "disabled",
        limitations: ["Test-only real-path Provider fixture."],
      }),
      disposition: { status: "comparable" },
      createdAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
    }),
    instructionTarget,
    providerFactory: () => new FakeNativeToolProvider({
      descriptor: { id: "campaign-test-provider" },
      steps: [fakeNativeModelOutput(
        { kind: "completion", summary: "The timeout is 4500 ms." },
        { usage: {
            inputTokens: 20,
            outputTokens: 8,
            totalTokens: 28,
            costUnits: null,
            metadata: {},
          },
        },
      )],
    }),
    productVersion: "campaign-test-product-v1",
    model,
    environment: "campaign-test-environment",
    createdAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
  });
}

function ref(id: string) {
  return Object.freeze({ id, revision: "v1" });
}
