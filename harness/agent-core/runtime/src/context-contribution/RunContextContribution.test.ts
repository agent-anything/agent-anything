import { describe, expect, it } from "vitest";
import { admitContextContribution } from "@agent-anything/context/active-context";
import { ContextContractError } from "@agent-anything/context/contract";
import {
  createLifecycleHookFeedbackContextAdmissionProfile,
  createLifecycleHookFeedbackContextContribution,
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

  it("admits bounded lifecycle Hook feedback as replaceable model Context", () => {
    const contribution = createLifecycleHookFeedbackContextContribution({
      id: "lifecycle-hook-feedback-1",
      revision: "1",
      runId: "run-1",
      feedback: {
        eventId: "stop-event-1",
        epoch: 1,
        round: 1,
        codes: ["task_incomplete"],
        message: "Continue the Run and complete the Task.",
        omittedReasonCount: 0,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(() => admitContextContribution(
      contribution,
      createLifecycleHookFeedbackContextAdmissionProfile(),
    )).not.toThrow();
    expect(contribution).toMatchObject({
      source: { owner: "agent-runtime", kind: "lifecycle_hook_feedback" },
      disclosure: { sensitivity: "internal", audiences: ["model"] },
      handling: {
        retention: "current",
        replacementKey: "lifecycle_hook_feedback",
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
