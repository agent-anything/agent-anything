import { describe, expect, it } from "vitest";
import { admitContextContribution } from "@agent-anything/context/active-context";
import { ContextContractError } from "@agent-anything/context/contract";
import {
  createControllerFeedbackContextAdmissionProfile,
  createControllerFeedbackContextContribution,
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

  it("admits bounded Controller feedback as replaceable model Context", () => {
    const contribution = createControllerFeedbackContextContribution({
      id: "controller-feedback-1",
      revision: "1",
      runId: "run-1",
      feedback: {
        source: { owner: "product", kind: "assessment", id: "assessment-1", revision: "1" },
        code: "task_incomplete",
        message: "Continue the Run and complete the Task.",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(() => admitContextContribution(
      contribution,
      createControllerFeedbackContextAdmissionProfile("product"),
    )).not.toThrow();
    expect(contribution).toMatchObject({
      source: { owner: "product", kind: "controller_feedback" },
      disclosure: { sensitivity: "internal", audiences: ["model"] },
      handling: {
        retention: "current",
        replacementKey: "controller_feedback",
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
