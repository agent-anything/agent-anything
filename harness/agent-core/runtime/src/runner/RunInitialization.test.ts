import { describe, expect, it } from "vitest";
import { createAgentInstructions } from "@agent-anything/agent-core/agent";
import { createAgentInstructionBinding } from "../instructions/index.js";
import { createInitialRunState } from "./RunInitialization.js";

describe("Run initialization", () => {
  it("creates one coherent immutable Run Progress state", () => {
    const agent = {
      id: "agent-1",
      revision: "1",
      name: "Agent 1",
      instructions: createAgentInstructions({
        id: "agent-1.instructions",
        release: { id: "agent-1.release", revision: "1" },
        model: { providerId: "provider-1", modelId: "model-1" },
        resolverRevision: "test-resolver.v1",
        blocks: [{
          id: "behavior",
          source: { owner: "test", kind: "instructions", id: "behavior", revision: "1" },
          content: "Complete the task.",
        }],
      }),
      output: { validate: (value: unknown) => ({ valid: true as const, output: value }) },
      metadata: {},
    };
    const state = createInitialRunState({
      runId: "run-1",
      agent,
      instructionBinding: createAgentInstructionBinding({
        run: { id: "run-1" },
        agent,
        effectiveFromRunRevision: 0,
        supersedes: null,
      }),
      input: { task: { id: "task-1" }, metadata: {} } as never,
      config: {
        workspace: null,
        identity: { id: "user-1" },
        permissions: { sessionAuthority: null },
        metadata: {},
      } as never,
      startedAt: "2026-01-01T00:00:00.000Z",
      deadlineAt: "2026-01-01T00:01:00.000Z",
      activeContextId: "context-1",
    });

    expect(state.progress).toEqual({
      checkpointSequence: 0,
      consecutiveNonAdvancingCheckpoints: 0,
      correctionRounds: 0,
      activeCorrectionRound: null,
      latestAssessment: null,
      latestAdvancement: null,
      basisFingerprint: null,
      recentCheckpoints: [],
    });
    expect(Object.isFrozen(state.progress)).toBe(true);
    expect(Object.isFrozen(state.progress.recentCheckpoints)).toBe(true);
  });
});
