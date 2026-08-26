import { describe, expect, it } from "vitest";

import { createAgentInstructions } from "@agent-anything/agent-core/agent";
import {
  assertAgentInstructionBindingMatches,
  createAgentInstructionBinding,
  snapshotAgentInstructionBinding,
} from "./AgentInstructionBinding.js";

describe("AgentInstructionBinding", () => {
  it("binds one exact Agent instruction revision to one Run revision", () => {
    const agent = testAgent("agent-1", "1");
    const binding = createAgentInstructionBinding({
      run: { id: "run-1" },
      agent,
      effectiveFromRunRevision: 0,
      supersedes: null,
    });

    expect(binding).toMatchObject({
      run: { id: "run-1" },
      agent: { id: "agent-1", revision: "1" },
      instructions: agent.instructions.ref,
      model: { providerId: "provider-1", modelId: "model-1" },
      effectiveFromRunRevision: 0,
      supersedes: null,
    });
    expect(binding.ref.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snapshotAgentInstructionBinding(binding)).toEqual(binding);
    expect(() => assertAgentInstructionBindingMatches({
      binding,
      run: { id: "run-1" },
      agent,
    })).not.toThrow();
  });

  it("creates a distinct immutable successor binding for handoff", () => {
    const first = createAgentInstructionBinding({
      run: { id: "run-1" },
      agent: testAgent("agent-1", "1"),
      effectiveFromRunRevision: 0,
      supersedes: null,
    });
    const second = createAgentInstructionBinding({
      run: { id: "run-1" },
      agent: testAgent("agent-2", "2"),
      effectiveFromRunRevision: 4,
      supersedes: first.ref,
    });

    expect(second.supersedes).toEqual(first.ref);
    expect(second.ref).not.toEqual(first.ref);
    expect(Object.isFrozen(second)).toBe(true);
  });

  it("rejects a binding used with another Agent", () => {
    const binding = createAgentInstructionBinding({
      run: { id: "run-1" },
      agent: testAgent("agent-1", "1"),
      effectiveFromRunRevision: 0,
      supersedes: null,
    });

    expect(() => assertAgentInstructionBindingMatches({
      binding,
      run: { id: "run-1" },
      agent: testAgent("agent-2", "1"),
    })).toThrow("does not match");
  });
});

function testAgent(id: string, revision: string) {
  return {
    id,
    revision,
    name: id,
    instructions: createAgentInstructions({
      id: `${id}.instructions`,
      release: { id: `${id}.release`, revision: "1" },
      model: { providerId: "provider-1", modelId: "model-1" },
      resolverRevision: "test-resolver.v1",
      blocks: [{
        id: "behavior",
        source: { owner: "test", kind: "instructions", id, revision: "1" },
        content: "Complete the task.",
      }],
    }),
    output: { validate: (value: unknown) => ({ valid: true as const, output: value }) },
    metadata: {},
  };
}
