import { describe, expect, it } from "vitest";
import { runRunProgressDeterministicEvaluation } from "./RunProgressEvaluation.js";

describe("Run Progress deterministic Evaluation", () => {
  it("covers hostile semantic trajectories without becoming progress authority", async () => {
    const report = await runRunProgressDeterministicEvaluation();
    const byId = new Map(report.cases.map((item) => [item.id, item]));
    const dispositions = (id: string) => byId.get(id)?.assessments.map(
      ({ disposition, reasonCode }) => [disposition, reasonCode],
    );

    expect(dispositions("equivalent-calls-ignore-volatile-identities")).toEqual([
      ["advanced", "new_trusted_fact"],
      ["repeated", "equivalent_fact_repeated"],
    ]);
    expect(dispositions("repeated-missing-target-stagnates")).toEqual([
      ["advanced", "new_trusted_fact"],
      ["repeated", "equivalent_fact_repeated"],
    ]);
    expect(dispositions("identical-successful-read-is-not-advancement")).toEqual([
      ["unchanged", "activity_without_structural_change"],
      ["repeated", "equivalent_fact_repeated"],
    ]);
    expect(dispositions("no-op-mutation-is-not-advancement")).toEqual([
      ["unchanged", "activity_without_structural_change"],
      ["repeated", "equivalent_fact_repeated"],
    ]);
    expect(dispositions("plan-text-churn-does-not-advance")).toEqual([
      ["unchanged", "plan_declaration_only"],
      ["repeated", "equivalent_fact_repeated"],
    ]);
    expect(dispositions("required-interaction-defers-assessment")?.at(-1)).toEqual([
      "deferred",
      "required_work_pending",
    ]);
    expect(dispositions("accepted-steering-clears-current-streak")?.at(-1)).toEqual([
      "unchanged",
      "progression_basis_changed",
    ]);
    expect(byId.get("accepted-steering-clears-current-streak")?.assessments.at(-1))
      .toMatchObject({ consecutiveNonAdvancingCheckpoints: 0, activeCorrectionRound: null });
    expect(dispositions("active-agent-cycle-cannot-manufacture-novelty")?.at(-1)).toEqual([
      "repeated",
      "equivalent_fact_repeated",
    ]);
    expect(dispositions("slow-novel-investigation-remains-advancing")).toEqual([
      ["advanced", "new_trusted_fact"],
      ["advanced", "new_trusted_fact"],
      ["advanced", "new_trusted_fact"],
    ]);
    expect(dispositions("parent-wait-defers-until-child-settlement")).toEqual([
      ["deferred", "required_work_pending"],
      ["advanced", "new_trusted_fact"],
    ]);
    expect(byId.get("correction-recovers-on-new-owner-fact")?.recovered).toBe(true);
  });

  it("proves finite no-progress termination before the generic iteration limit", async () => {
    const report = await runRunProgressDeterministicEvaluation();

    expect(report.runtimeProbe).toEqual({
      status: "blocked",
      code: "runtime_no_progress",
      failure: null,
      controllerTurns: 2,
      progressAssessments: 2,
      correctionRounds: 1,
      genericLimitAvoided: true,
    });
    expect(report.recoveredCaseCount).toBe(1);
    expect(report.prohibitedDisclosureCount).toBe(0);
    expect(report.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(report)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("run-progress-evaluation-prohibited-payload");
  });

  it("is deterministic across repeated execution", async () => {
    const first = await runRunProgressDeterministicEvaluation();
    const second = await runRunProgressDeterministicEvaluation();

    expect(second).toEqual(first);
    expect(second.digest).toBe(first.digest);
  });
});
