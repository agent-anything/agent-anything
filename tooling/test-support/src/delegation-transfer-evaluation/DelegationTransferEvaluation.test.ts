import { describe, expect, it } from "vitest";
import {
  runDelegationTransferDeterministicEvaluation,
  runDelegationTransferModelDiagnostic,
} from "./DelegationTransferEvaluation.js";

describe("Delegation Transfer deterministic Evaluation", () => {
  it("proves recursive transfer truth and records product-effectiveness diagnostics", async () => {
    const report = await runDelegationTransferDeterministicEvaluation();

    expect(report.metrics).toEqual({
      objectiveFidelityRate: 1,
      unnecessaryDelegationCount: 0,
      semanticDriftCount: 0,
      resultAttributionRate: 1,
      effectTruthRate: 1,
      completionRate: 1,
      toolCallCount: 2,
      modelTurnCount: 8,
      latencyMs: 289,
      humanInteractionEvents: 0,
      terminalOutcome: "succeeded",
    });
    expect(Object.values(report.invariants).every(Boolean)).toBe(true);
    expect(report).toMatchObject({
      revision: "delegation-transfer-deterministic-evaluation-v6",
      descendantRunCount: 2,
      settledResultCount: 2,
      prohibitedDisclosureCount: 0,
    });
    expect(report.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(report)).toBe(true);
  }, 120_000);

  it("is deterministic across repeated execution", async () => {
    const first = await runDelegationTransferDeterministicEvaluation();
    const second = await runDelegationTransferDeterministicEvaluation();

    expect(second).toEqual(first);
  }, 120_000);

  it("keeps optional model diagnostics outside deterministic acceptance", async () => {
    await expect(runDelegationTransferModelDiagnostic({
      provider: null,
      target: null,
      unavailableReasons: ["credential_unavailable", "environment_unavailable"],
    })).resolves.toEqual({
      status: "unavailable",
      reasons: ["provider_unavailable", "credential_unavailable", "environment_unavailable"],
    });
  });
});
