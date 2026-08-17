import { describe, expect, it } from "vitest";
import { admitContextContribution } from "@agent-anything/context/active-context";
import { ContextContractError } from "@agent-anything/context/contract";
import {
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
