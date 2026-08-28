import { describe, expect, it } from "vitest";
import {
  createTaskFulfillmentFailure,
  snapshotTaskFulfillmentAssessment,
  snapshotTaskFulfillmentEvaluationInput,
  snapshotTaskFulfillmentEvaluatorRef,
  type TaskFulfillmentEvaluationInput,
} from "./TaskFulfillment.js";

const NOW = "2026-08-28T00:00:00.000Z";

describe("Task Fulfillment Contracts", () => {
  it("snapshots the original Task objective and exact completion basis", () => {
    const input = createInput();
    const snapshot = snapshotTaskFulfillmentEvaluationInput(input);

    expect(snapshot).toEqual(input);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.task)).toBe(true);
    expect(Object.isFrozen(snapshot.interaction)).toBe(true);
  });

  it("rejects a fulfilled assessment that still carries unresolved findings", () => {
    const input = createInput();
    expect(() => snapshotTaskFulfillmentAssessment({
      ref: input.assessment,
      evaluator: { owner: "helarc", id: "task-fulfillment", revision: "1" },
      run: input.run,
      turn: input.turn,
      objective: input.objective,
      proposal: input.proposal,
      status: "fulfilled",
      rationale: "Everything is complete.",
      findings: [{
        kind: "missing_outcome",
        code: "outcome_missing",
        message: "The command did not run.",
      }],
      feedback: null,
      assessedAt: NOW,
    })).toThrow(/cannot carry unresolved findings/u);
  });

  it("requires continuation feedback for non-fulfilled assessments", () => {
    const input = createInput();
    expect(() => snapshotTaskFulfillmentAssessment({
      ref: input.assessment,
      evaluator: { owner: "helarc", id: "task-fulfillment", revision: "1" },
      run: input.run,
      turn: input.turn,
      objective: input.objective,
      proposal: input.proposal,
      status: "incomplete",
      rationale: "The requested command was not run.",
      findings: [],
      feedback: null,
      assessedAt: NOW,
    })).toThrow(/requires continuation feedback/u);
  });

  it("validates evaluator identity and Failure metadata", () => {
    expect(snapshotTaskFulfillmentEvaluatorRef({
      owner: "helarc",
      id: "task-fulfillment",
      revision: "1",
    })).toEqual({ owner: "helarc", id: "task-fulfillment", revision: "1" });
    expect(() => snapshotTaskFulfillmentEvaluatorRef({
      owner: "helarc product",
      id: "task-fulfillment",
      revision: "1",
    })).toThrow(/canonical token/u);
    expect(() => createTaskFulfillmentFailure({
      code: "task_fulfillment_failed",
      message: "Evaluation failed.",
      retryable: false,
      metadata: [] as unknown as Readonly<Record<string, unknown>>,
    })).toThrow(/metadata must be a record/u);
  });
});

function createInput(): TaskFulfillmentEvaluationInput {
  return {
    assessment: { id: "assessment-1", revision: "1" },
    run: { id: "run-1" },
    turn: { run: { id: "run-1" }, id: "turn-1", sequence: 1 },
    objective: { id: "task-1", kind: "helarc.code-task", revision: "sha256:objective" },
    task: {
      id: "task-1",
      kind: "helarc.code-task",
      input: { prompt: "Create and run the program." },
      createdAt: NOW,
      metadata: {},
    },
    proposal: { id: "proposal-1", revision: "sha256:proposal" },
    output: { summary: "Done." },
    interaction: {
      id: "interaction-1",
      revision: "1",
      messages: [],
      unsettledCalls: [],
      settledCallCount: 0,
    },
    verification: { snapshot: { runId: "run-1", revision: 0 }, gate: null },
    requestedAt: NOW,
    deadlineAt: "2026-08-28T00:00:05.000Z",
  };
}
