import { describe, expect, it } from "vitest";
import { admitContextContribution } from "@agent-anything/context/active-context";
import { ContextContractError } from "@agent-anything/context/contract";
import {
  createStopFeedbackContextAdmissionProfile,
  createStopFeedbackContextContribution,
  createTaskContextAdmissionProfile,
  createTaskContextContribution,
} from "./RunContextContribution.js";

describe("Run Context Contribution admission", () => {
  it("admits the exact Task profile", () => {
    const contribution = taskContribution();

    expect(() => admitContextContribution(
      contribution,
      createTaskContextAdmissionProfile(),
    )).not.toThrow();
  });

  it("does not derive broader admission from a candidate", () => {
    const contribution = taskContribution();
    const elevated = Object.freeze({
      ...contribution,
      handling: Object.freeze({
        ...contribution.handling,
        precedence: 101,
      }),
    });

    expect(() => admitContextContribution(
      elevated,
      createTaskContextAdmissionProfile(),
    )).toThrowError(ContextContractError);
  });

  it("admits bounded Runner-owned Stop feedback as replaceable model Context", () => {
    const contribution = createStopFeedbackContextContribution({
      id: "stop-feedback-1",
      revision: "1",
      runId: "run-1",
      feedback: {
        review: { runId: "run-1", sequence: 1 },
        owner: "task_fulfillment",
        severity: "required",
        round: 1,
        code: "task_incomplete",
        message: "Continue the Run and complete the Task.",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(() => admitContextContribution(
      contribution,
      createStopFeedbackContextAdmissionProfile(),
    )).not.toThrow();
    expect(contribution).toMatchObject({
      source: { owner: "agent-runtime", kind: "run_stop_feedback" },
      disclosure: { sensitivity: "internal", audiences: ["model"] },
      handling: {
        retention: "current",
        replacementKey: "run_stop_feedback",
        instructionRole: "data",
        necessity: "mandatory",
      },
    });
    expect(JSON.stringify(contribution)).not.toContain("credential");
  });
});

function taskContribution() {
  return createTaskContextContribution({
    id: "contribution-1",
    runId: "run-1",
    task: {
      id: "task-1",
      kind: "test",
      input: Object.freeze({ prompt: "Inspect the repository." }),
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  });
}
