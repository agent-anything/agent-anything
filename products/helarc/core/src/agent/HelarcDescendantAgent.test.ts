import { createDelegationLimits, type DelegationResult } from "@agent-anything/agent-runtime/delegation";
import type { RunnerDelegationComposition } from "@agent-anything/agent-runtime/runner";
import { describe, expect, it } from "vitest";
import { createHelarcDelegatedWorkerAgent } from "./HelarcAgent.js";
import { createHelarcDescendantAgentContribution } from "./HelarcDescendantAgent.js";

describe("Helarc descendant Agent contribution", () => {
  it("preserves surrounding whitespace and embedded indentation in delegated text", async () => {
    const prompt = "\r\n\tInspect this example:\n    return 1;\n  ";
    const description = "\t Inspection \r\n";
    const result = await prepareDelegation({ prompt, description });
    expect(result.preparation.task.input).toEqual({ prompt });
    expect(result.preparation.objective.text).toBe(prompt);
    expect(result.preparation.task.metadata.description).toBe(description);
  });

  it.each([
    ["missing prompt", {}],
    ["null prompt", { prompt: null }],
    ["non-string prompt", { prompt: 123 }],
    ["empty prompt", { prompt: "" }],
    ["whitespace-only prompt", { prompt: " \t\r\n\u3000" }],
    ["oversized original prompt", { prompt: "x".repeat(64_000) + "\n" }],
    ["blank description", { prompt: "Inspect.", description: " \n" }],
    ["oversized description", { prompt: "Inspect.", description: "x".repeat(1_024) + "\n" }],
  ])("rejects %s", async (_label, input) => {
    await expect(prepareDelegation(input)).rejects.toThrow(/bounded non-empty text/);
  });

  it("accepts exact preparation text limits without stripping whitespace", async () => {
    const prompt = "\n" + "x".repeat(63_998) + "\n";
    const description = " " + "x".repeat(1_022) + " ";
    const result = await prepareDelegation({ prompt, description });
    expect(result.preparation.task.input).toEqual({ prompt });
    expect(result.preparation.task.metadata.description).toBe(description);
  });

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
        terminal: {
          status,
          code: status === "stopped" ? "stop_accepted" : "completion_accepted",
          stopReason: status === "stopped" ? "No further work." : null,
        },
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
        stop_reason: status === "stopped" ? "No further work." : null,
      },
    });
    expect(outcome.failure).toBeNull();
    expect(outcome.output).not.toHaveProperty("result_ref");
    expect(outcome.output).not.toHaveProperty("child_run_id");
  });

  it.each(["stopped", "failed", "cancelled"] as const)(
    "retains all text blocks of the latest report turn for a %s Child",
    (status) => {
      expect(projectNarrative(status, [
        ["Earlier report."],
        ["First finding.", "   ", "Second finding."],
        [],
      ])).toBe("First finding.\n\nSecond finding.");
    },
  );

  it("does not substitute a stopped Child's reason for absent narrative", () => {
    expect(projectNarrative("stopped", [["  "], []])).toBeNull();
  });

  it("marks a bounded report as truncated", () => {
    const text = projectNarrative("stopped", [["x".repeat(16_001)]]);
    expect(text).toHaveLength(16_000);
    expect(text).toMatch(/\[Child report truncated\.\]$/u);
    expect(projectNarrative("stopped", [["x".repeat(16_000)]]))
      .toBe("x".repeat(16_000));
  });

  it("keeps a succeeded Child's final output as its narrative", () => {
    expect(projectNarrative("succeeded", [["Earlier report."]], { kind: "complete", summary: "Final report." }))
      .toBe("Final report.");
  });
});

function prepareDelegation(input: unknown) {
  const createdAt = "2026-09-01T00:00:00.000Z";
  const agent = createHelarcDelegatedWorkerAgent({ providerId: "test", modelId: "test" });
  const { delegation } = createHelarcDescendantAgentContribution(agent, createdAt);
  const run = { id: "parent-run" };
  const action = { run, id: "delegate-action", sequence: 1 };
  const task = { id: "parent-task", kind: "test", input: {}, metadata: {}, createdAt };
  return delegation.preparation.prepare({
    root: { run, task },
    parent: {
      run,
      task: { id: task.id },
      action,
      lineage: { kind: "root", root: run, depth: 0 },
    },
    targetAgent: { id: agent.id, revision: agent.revision },
    toolCall: {
      toolCallId: "delegate-call",
      attempt: { id: "delegate-attempt", runAction: action, modelCall: null },
      parentRunAction: action,
      toolRevision: { tool: { namespace: "helarc", name: "agent" }, revision: "2" },
      binding: {
        kind: "descendant_agent",
        agent: { id: agent.id, revision: agent.revision },
        revision: "descendant-agent-binding-1",
      },
      selectionRevision: "selection-1",
      exposureProofId: "exposure-1",
      origin: "model",
      input,
      inputDigest: "sha256:test-input",
      createdAt,
    },
    authorityCeiling: [],
    limitCeiling: createDelegationLimits({
      maxControllerTurns: 8,
      maxActions: 16,
      maxModelInputTokens: 8_000,
      maxModelOutputTokens: 2_000,
      maxCostUnits: 8_000,
      maxDurationMs: 60_000,
      maxContextBytes: 16_384,
      maxResultBytes: 65_536,
    }),
  });
}

function projectNarrative(
  status: "succeeded" | "stopped" | "failed" | "cancelled",
  turns: readonly (readonly string[])[],
  finalOutput: unknown = null,
) {
  const agent = createHelarcDelegatedWorkerAgent({ providerId: "test", modelId: "test" });
  const { delegation } = createHelarcDescendantAgentContribution(agent, "2026-09-01T00:00:00.000Z");
  return delegation.narrativeProjection.project({
    childResult: {
      status,
      finalOutput,
      cause: { kind: "stop", reason: "No further work." },
      items: turns.map((texts) => ({
        payload: {
          kind: "controller_turn",
          modelItems: texts.map((text) => ({ kind: "assistant_text", text })),
        },
      })),
    },
  } as unknown as Parameters<RunnerDelegationComposition["narrativeProjection"]["project"]>[0]);
}
