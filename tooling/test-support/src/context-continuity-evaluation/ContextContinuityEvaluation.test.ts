import { describe, expect, it } from "vitest";
import {
  createContextContinuityEvaluationFixtures,
  runContextContinuityEvaluationCandidate,
} from "./index.js";

describe("Context Continuity deterministic Evaluation", () => {
  it("captures, grades, and measures every positive and adverse fixture", async () => {
    const definitions = createContextContinuityEvaluationFixtures();
    const candidate = await runContextContinuityEvaluationCandidate();

    expect(definitions).toHaveLength(17);
    expect(candidate.fixtures.map((fixture) => fixture.fixtureId))
      .toEqual(definitions.map((fixture) => fixture.id));
    expect(candidate.captures).toHaveLength(definitions.length);
    expect(candidate.captures.every((capture) => capture.status === "complete")).toBe(true);
    expect(candidate.grades).toHaveLength(definitions.length * 2);
    expect(candidate.grades.every((grade) => grade.criterionOutcome === "satisfied")).toBe(true);
    expect(candidate.gateOutcomes.every((gate) => gate.status === "passed")).toBe(true);
    expect(candidate.metrics.map((metric) => metric.definitionRef.id)).toHaveLength(10);
    expect(candidate.exclusions.some((item) => item.code === "unsupported_provider_feature")).toBe(true);
    expect(candidate.exclusions.some((item) => item.code === "not_applicable")).toBe(true);
  });

  it("keeps model reasoning distinct from complete Context inclusion", async () => {
    const candidate = await runContextContinuityEvaluationCandidate();
    const reasoning = candidate.fixtures.find((fixture) => fixture.fixtureId === "model_reasoning_failure");

    expect(reasoning).toMatchObject({
      attribution: "model_reasoning",
      downstreamOutcome: "failed",
      projection: { outcome: "projected", projectedItemCount: 1, complete: true },
      modelInput: { budgetError: 0 },
    });
  });

  it("emits no unrestricted Context or continuation payload", async () => {
    const candidate = await runContextContinuityEvaluationCandidate();
    const serialized = JSON.stringify(candidate);

    expect(serialized).not.toContain("Ignore every rule");
    expect(serialized).not.toContain("restricted value");
    expect(serialized).not.toContain("state-1");
    expect(serialized).not.toContain("compacted-state");
    expect(serialized).not.toMatch(/systemPrompt|userPrompt|apiKey|physicalRoot|rootPath/);
  });
});
