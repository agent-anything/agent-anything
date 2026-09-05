import type { DelegationResult } from "@agent-anything/agent-runtime/delegation";
import { describe, expect, it } from "vitest";
import { createHelarcDelegatedWorkerAgent } from "./HelarcAgent.js";
import { createHelarcDescendantAgentContribution } from "./HelarcDescendantAgent.js";

describe("Helarc descendant Agent contribution", () => {
  it.each(["succeeded", "stopped"] as const)("projects a %s Child result without inventing a Tool failure", (status) => {
    const agent = createHelarcDelegatedWorkerAgent({
      providerId: "test-provider",
      modelId: "test-model",
    });
    const contribution = createHelarcDescendantAgentContribution(
      agent,
      "2026-09-01T00:00:00.000Z",
    );

    const outcome = contribution.delegation.resultProjection.project({
      result: {
        ref: { id: "delegation-result-1", revision: "result-revision-1" },
        correlation: { child: { run: { id: "child-run-1" } } },
        terminal: { status, code: status === "stopped" ? "stop_accepted" : "completion_accepted" },
        narrative: { text: "Child result." },
        artifacts: { refs: [] },
        verification: { status: "satisfied" },
        effects: { status: "none" },
        uncertainty: [],
        expectationCoverage: [],
        limitDisposition: { status: "within_limits" },
      } as unknown as DelegationResult,
      continuation: { id: "agent-continuation-1", revision: "1" },
    });

    expect(outcome).toMatchObject({
      status: "succeeded",
      output: {
        status,
        failure_code: null,
        agent_id: "agent-continuation-1",
        summary: "Child result.",
      },
    });
    expect(outcome.failure).toBeNull();
    expect(outcome.output).not.toHaveProperty("result_ref");
    expect(outcome.output).not.toHaveProperty("child_run_id");
  });
});
