import { describe, expect, expectTypeOf, it } from "vitest";
import {
  snapshotAgent,
  type Agent,
} from "./agent/index.js";
import {
  snapshotRunInput,
} from "./input/index.js";
import {
  snapshotRunWorkspace,
  type RunWorkspace,
} from "./run/index.js";
import type { AgentTask } from "./task/index.js";

describe("Agent Core contracts", () => {
  it("keeps Agent identity independent from Tool exposure", () => {
    const input: Agent<{ summary: string }> = {
      id: "agent",
      name: "Agent",
      instructions: "Complete the task.",
      output: {
        validate(candidate) {
          return typeof candidate === "object" && candidate !== null
            ? { valid: true, output: { summary: "done" } }
            : { valid: false, message: "invalid" };
        },
      },
      metadata: { source: "test" },
    };

    const agent = snapshotAgent(input);

    expect(agent).not.toHaveProperty("tools");
    expect(Object.isFrozen(agent)).toBe(true);
    expect(Object.isFrozen(agent.metadata)).toBe(true);
  });

  it("keeps AgentTask independent from Workspace context", () => {
    const task: AgentTask<{ prompt: string }> = {
      id: "task",
      kind: "test.task",
      input: { prompt: "work" },
      createdAt: "2026-08-01T00:00:00.000Z",
      metadata: {},
    };

    const input = snapshotRunInput({
      task,
      items: [],
      metadata: {},
    });

    expect(input.task).not.toHaveProperty("workspaceScope");
    expect(Object.isFrozen(input.task)).toBe(true);
  });

  it("snapshots one primary Workspace and unique additional Workspaces", () => {
    const workspace: RunWorkspace = {
      primary: createWorkspace("primary"),
      additional: [createWorkspace("docs")],
    };

    const snapshot = snapshotRunWorkspace(workspace);

    expect(snapshot.primary.id).toBe("primary");
    expect(snapshot.additional.map((item) => item.id)).toEqual(["docs"]);
    expect(Object.isFrozen(snapshot.additional)).toBe(true);
    expect(() => snapshotRunWorkspace({
      primary: createWorkspace("duplicate"),
      additional: [createWorkspace("duplicate")],
    })).toThrow(/duplicate workspace id/);
  });
  it("keeps caller-assigned identity out of RunInput", () => {
    expectTypeOf<Parameters<typeof snapshotRunInput>[0]>().not.toHaveProperty(
      "runId",
    );
  });
});

function createWorkspace(id: string) {
  return {
    id,
    name: id,
    rootRef: `opaque://${id}`,
    trustState: "trusted" as const,
    source: "test",
    policyRefs: [],
    metadata: {},
  };
}
