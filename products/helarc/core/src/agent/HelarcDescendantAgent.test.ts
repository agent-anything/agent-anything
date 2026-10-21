import { createDelegationLimits, type DelegationResult } from "@agent-anything/agent-runtime/delegation";
import type { RunnerDelegationComposition } from "@agent-anything/agent-runtime/runner";
import { createModelCallRef, type ModelToolCall } from "@agent-anything/model-interaction";
import { describe, expect, it } from "vitest";
import { resolveHelarcFinalReply } from "../controller/HelarcFinalReply.js";
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

  it.each(["completed"] as const)("projects a %s Child result without inventing a Tool failure", (status) => {
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
          code: "completion_accepted",
        },
        narrative: { text: "Child result." },
        artifacts: { refs: [] },
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

  it.each(["failed", "cancelled"] as const)(
    "retains all text blocks of the latest report turn for a %s Child",
    (status) => {
      expect(projectNarrative(status, [
        ["Earlier report."],
        ["First finding.", "   ", "Second finding."],
        [],
      ])).toBe("First finding.\n\nSecond finding.");
    },
  );

  it.each([null, "Useful findings collected before the failure."].flatMap(narrative =>
    ["model_output_limit_exhausted", "model_protocol_recovery_exhausted"].map(code => ({narrative, code}))))(
    "delivers a failed Child's actual cause without treating diagnostic text as narrative: %j",
    ({narrative, code}) => {
      const agent = createHelarcDelegatedWorkerAgent({ providerId: "test", modelId: "test" });
      const { delegation } = createHelarcDescendantAgentContribution(agent, "2026-09-01T00:00:00.000Z");
      const diagnostic = {
        message: code === "model_output_limit_exhausted"
          ? "Model output was truncated at the configured 2048-token limit after 3 generation attempts."
          : "The model did not provide an ending signal after 2 correction opportunities.",
        messageTruncated: false, retryable: false, category: null, underlyingCode: null,
      };
      const outcome = delegation.resultProjection.project({
        result: {
          ref: { id: "failed-result", revision: "1" },
          correlation: { child: { run: { id: "child-run" } } },
          terminal: {
            status: "failed", code, failureKind: "model",
            failureDiagnostic: diagnostic,
          },
          narrative: narrative === null ? null : { text: narrative },
          artifacts: { refs: [] }, effects: { status: "known" }, uncertainty: [],
          expectationCoverage: [{ required: true, disposition: narrative === null ? "failed" : "present" }],
          limitDisposition: { status: "within_limits" },
        } as unknown as DelegationResult,
        continuation: { id: "child-reference", revision: "1" },
      });
      expect(outcome).toEqual({
        status: narrative === null ? "failed" : "partial",
        output: {
          agent_id: "child-reference", status: "failed", summary: narrative ?? "",
          artifact_refs: [], effect_status: "known", uncertainty: [],
          failure_code: code,
          failure: { kind: "model", code, ...diagnostic },
        },
        failure: {
          owner: "helarc", code, message: diagnostic.message,
          retryable: false, metadata: {},
        },
      });
    },
  );

  it("does not substitute a failed Child's cause for absent narrative", () => {
    expect(projectNarrative("failed", [["  "], []])).toBeNull();
  });

  it("marks a bounded report as truncated", () => {
    const text = projectNarrative("failed", [["x".repeat(16_001)]]);
    expect(text).toHaveLength(16_000);
    expect(text).toMatch(/\[Child report truncated\.\]$/u);
    expect(projectNarrative("failed", [["x".repeat(16_000)]]))
      .toBe("x".repeat(16_000));
  });

  it("keeps a completed Child's final output as its narrative", () => {
    expect(projectNarrative("completed", [["Earlier report."]], { kind: "complete", summary: "Final report." }))
      .toBe("Final report.");
  });

  it.each([
    { response: undefined, expected: "First finding.\n\nSecond finding.", disposition: "adopted_previous" },
    { response: "Revised findings.", expected: "Revised findings.", disposition: "supplied" },
    { response: "The report was provided above.", expected: "The report was provided above.", disposition: "supplied" },
    { response: "", expected: "", disposition: "explicit_empty" },
  ])("delivers the selected Child reply, not its private conversation: $disposition / $response", async ({response, expected, disposition}) => {
    const call: ModelToolCall = {
      name: "final_result",
      modelCallRef: createModelCallRef({
        providerRequestId: "child-request-2", controllerRequestId: "child-controller-2",
        turnId: "child-turn-2", contentBlockOrdinal: 0, branchId: "child-run:main",
      }),
      providerCallRef: null, ordinal: 0, input: response === undefined ? {} : {response},
    };
    const resolved = resolveHelarcFinalReply({
      runId: "child-run", interactionRevision: "3", call,
      modelItems: [{id: call.modelCallRef.id, kind: "model_tool_call", call, metadata: {}}],
      previous: {
        runId: "child-run", runItemId: "child-item-1", runItemSequence: 1, turnId: "child-turn-1",
        textBlocks: [
          {modelItemId: "finding-1", ordinal: 0, text: "First finding."},
          {modelItemId: "finding-2", ordinal: 1, text: "Second finding."},
        ],
      },
    });
    const agent = createHelarcDelegatedWorkerAgent({providerId: "test", modelId: "test"});
    const retained = agent.output.validate(JSON.parse(JSON.stringify({kind: "complete", ...resolved})));
    if (!retained.valid) throw new Error(retained.message);
    expect(retained.output.finalReply?.disposition).toBe(disposition);
    if (response === undefined) expect(retained.output.source).toMatchObject({
      kind: "model_text", turnId: "child-turn-1", modelItemIds: ["finding-1", "finding-2"],
    });
    const narrative = projectNarrative("completed", [["Private commentary."], ["First finding.", "Second finding."]], retained.output);
    const {delegation} = createHelarcDescendantAgentContribution(agent, "2026-09-01T00:00:00.000Z");
    const parentResult = await delegation.resultProjection.project({
      result: {
        terminal: {status: "completed", code: "completion_accepted"},
        narrative: narrative ? {text: narrative} : null,
        artifacts: {refs: []}, effects: {status: "none"}, uncertainty: [],
        expectationCoverage: [{required: true, disposition: narrative ? "present" : "failed"}],
        limitDisposition: {status: "within_limits"},
      } as unknown as DelegationResult,
      continuation: {id: "child-reference", revision: "1"},
    });
    expect(parentResult.output).toMatchObject({summary: expected, agent_id: "child-reference", status: "completed"});
    expect(narrative).toBe(expected);
    expect(parentResult.output).not.toHaveProperty("messages");
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
      toolRevision: { tool: { namespace: "helarc", name: "agent" }, revision: "3" },
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
  status: "completed" | "failed" | "cancelled",
  turns: readonly (readonly string[])[],
  finalOutput: unknown = null,
) {
  const agent = createHelarcDelegatedWorkerAgent({ providerId: "test", modelId: "test" });
  const { delegation } = createHelarcDescendantAgentContribution(agent, "2026-09-01T00:00:00.000Z");
  return delegation.narrativeProjection.project({
    childResult: {
      status,
      finalOutput,
      items: turns.map((texts) => ({
        payload: {
          kind: "controller_turn",
          modelItems: texts.map((text) => ({ kind: "assistant_text", text })),
        },
      })),
    },
  } as unknown as Parameters<RunnerDelegationComposition["narrativeProjection"]["project"]>[0]);
}
