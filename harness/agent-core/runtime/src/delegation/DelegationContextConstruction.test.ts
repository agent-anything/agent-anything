import { describe, expect, it } from "vitest";
import type { AgentTask } from "@agent-anything/agent-core/task";
import {
  createDelegationContextMaterial,
  type DelegationContextMaterial,
  type DelegationRequest,
} from "./DelegationRequest.js";
import {
  assessDelegationContextConstruction,
} from "./DelegationContextConstruction.js";

describe("delegation Context construction", () => {
  it("preserves the immutable root purpose and reports optional omissions", () => {
    const rootTask = task();
    const rootPurpose = rootPurposeMaterial(rootTask);
    const optional = Object.freeze({
      owner: "product",
      kind: "project_context",
      id: "project-context-1",
      revision: "1",
    });
    const request = requestWithEntries(rootTask, [
      { role: "root_purpose", material: rootPurpose.ref, necessity: "mandatory" },
      { role: "product_context", material: optional, necessity: "optional" },
    ]);

    expect(assessDelegationContextConstruction({
      request,
      rootTask,
      rootPurpose,
    })).toEqual({
      rootPurpose,
      omitted: [optional],
    });
  });

  it("rejects mandatory material without an admitted source owner", () => {
    const rootTask = task();
    const rootPurpose = rootPurposeMaterial(rootTask);
    const request = requestWithEntries(rootTask, [
      { role: "root_purpose", material: rootPurpose.ref, necessity: "mandatory" },
      {
        role: "parent_fact",
        material: {
          owner: "parent",
          kind: "fact",
          id: "fact-1",
          revision: "1",
        },
        necessity: "mandatory",
      },
    ]);

    expect(() => assessDelegationContextConstruction({
      request,
      rootTask,
      rootPurpose,
    }))
      .toThrow("has no admitted source owner");
  });
});

function task(): AgentTask {
  return Object.freeze({
    id: "root-task",
    kind: "test.root",
    input: Object.freeze({ objective: "Preserve this purpose." }),
    createdAt: "2026-08-25T00:00:00.000Z",
    metadata: Object.freeze({}),
  });
}

function requestWithEntries(
  rootTask: AgentTask,
  entries: DelegationRequest["contextPlan"]["entries"],
): DelegationRequest {
  const rootPurposeAnchor = entries.find(({ role }) => role === "root_purpose")!.material;
  return {
    origin: {
      root: { run: { id: "root-run" }, task: { id: rootTask.id } },
    },
    rootPurposeAnchor,
    contextPlan: { entries },
  } as DelegationRequest;
}

function rootPurposeMaterial(rootTask: AgentTask): DelegationContextMaterial {
  return createDelegationContextMaterial({
    owner: "test-product",
    kind: "root_task_purpose",
    id: rootTask.id,
    payload: Object.freeze({
      kind: "test_root_purpose",
      objective: "Preserve this purpose.",
    }),
  });
}
