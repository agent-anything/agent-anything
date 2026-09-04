import type { RunActionEnvelope } from "@agent-anything/agent-core/run-action";
import type { RunInput } from "@agent-anything/agent-core/input";
import type { RunItem, RunResult } from "./index.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as runApi from "./index.js";
import { createRunResult } from "./index.js";

describe("Agent Core Run public API", () => {
  it("exposes Action and Run contracts without the Runner implementation", () => {
    const action: RunActionEnvelope<{ readonly kind: "tool"; readonly name: string }> = {
      ref: { run: { id: "run-1" }, id: "action-1", sequence: 1 },
      provenance: {
        kind: "controller",
        turn: { run: { id: "run-1" }, id: "turn-1", sequence: 1 },
        candidateIndex: 0,
      },
      subject: { kind: "tool", name: "codeAgent.readFile" },
      basis: { runRevision: 0, activeAgentId: "agent-1", controllerProjectionRevision: null },
      materializedAt: "2026-01-01T00:00:00.000Z",
    };
    const item: RunItem = {
      ref: { run: { id: "run-1" }, id: "item-1", sequence: 1 },
      committedInRevision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { kind: "run_action", action },
    };
    const cause = {
      ref: { run: { id: "run-1" }, id: "run-1:cause:1", revision: "1" },
      kind: "completion" as const,
      code: "completion_accepted" as const,
      source: {
        owner: "agent-runtime",
        kind: "run_completion_acceptance",
        id: "run-1:completion:1",
        revision: "1",
        run: { id: "run-1" },
      },
      underlying: [],
      omittedUnderlyingCount: 0,
      recordedAt: "2026-01-01T00:00:01.000Z",
    };
    const result = createRunResult({
        runId: "run-1",
        taskId: "task-1",
        startingAgent: { id: "agent-1", revision: "1" },
        finalActiveAgent: { id: "agent-1", revision: "1" },
        startingInstructionBinding: {
          id: "run-1:agent-instruction-binding:0",
          revision: `sha256:${"0".repeat(64)}`,
        },
        finalInstructionBinding: {
          id: "run-1:agent-instruction-binding:0",
          revision: `sha256:${"0".repeat(64)}`,
        },
        startedAt: "2026-01-01T00:00:00.000Z",
        settlement: {
          status: "succeeded",
          completedAt: "2026-01-01T00:00:01.000Z",
          cause: cause.ref,
          output: { summary: "done" },
        },
        cause,
        settlementCauses: [cause],
        items: [item],
      });

    expect(result.items).toEqual([item]);
    expect(result.status).toBe("succeeded");
    expectTypeOf(result).toMatchTypeOf<RunResult<{ summary: string }>>();
    expectTypeOf<RunInput>().toBeObject();
  });

  it("keeps Run semantics separate from Runner and Action Execution values", () => {
    expect(runApi).toHaveProperty("createRunResult");
    expect(runApi).not.toHaveProperty("Runner");
    expect(runApi).not.toHaveProperty("ActionEnforcementPipeline");
    expect(runApi).not.toHaveProperty("createSandboxExecutionGateway");
  });
});
