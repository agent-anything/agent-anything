import { describe, expect, it } from "vitest";
import { createInitialRunState } from "./RunInitialization.js";

describe("Run initialization", () => {
  it("creates one coherent immutable Run Progress state", () => {
    const state = createInitialRunState({
      runId: "run-1",
      agent: { id: "agent-1", revision: "1" } as never,
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
