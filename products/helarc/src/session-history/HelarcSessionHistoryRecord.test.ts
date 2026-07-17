import { describe, expect, it } from "vitest";
import { createHelarcSessionHistoryRecord } from "./HelarcSessionHistoryRecord.js";

describe("HelarcSessionHistoryRecord", () => {
  it("creates product-safe completed session records", () => {
    const result = createHelarcSessionHistoryRecord(recordInput());

    expect(result).toMatchObject({
      ok: true,
      record: {
        id: "history-1",
        taskId: "task-1",
        taskText: "Update docs",
        workspace: {
          profileId: "workspace:a",
          displayName: "agent-anything",
        },
        provider: {
          profileId: "provider-a",
          displayName: "Provider A",
          endpointLabel: "provider.local",
          model: "model-a",
        },
        status: "completed",
        run: {
          runId: "run-1",
          status: "completed",
          terminal: {
            status: "completed",
            runtimeStatus: "succeeded",
          },
        },
        patch: {
          decision: "accepted",
          status: "applied",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("authorization");
  });

  it("rejects running sessions and incomplete references", () => {
    expect(createHelarcSessionHistoryRecord({
      ...recordInput(),
      status: "running",
    })).toMatchObject({
      ok: false,
      error: { code: "session_history_status_invalid" },
    });

    expect(createHelarcSessionHistoryRecord({
      ...recordInput(),
      workspace: { profileId: null, displayName: "", path: "D:\\repo" },
    })).toMatchObject({
      ok: false,
      error: { code: "session_history_workspace_invalid" },
    });

    expect(createHelarcSessionHistoryRecord({
      ...recordInput(),
      provider: {
        profileId: null,
        displayName: "Provider",
        endpointLabel: "",
        model: "model-a",
      },
    })).toMatchObject({
      ok: false,
      error: { code: "session_history_provider_invalid" },
    });

    expect(createHelarcSessionHistoryRecord({
      ...recordInput(),
      run: {
        ...recordInput().run,
        terminal: {
          ...recordInput().run.terminal,
          eventCount: 2,
        },
      },
    })).toMatchObject({
      ok: false,
      error: { code: "session_history_run_invalid" },
    });
  });
});

function recordInput() {
  return {
    id: " history-1 ",
    taskId: " task-1 ",
    taskText: " Update docs ",
    workspace: {
      profileId: " workspace:a ",
      displayName: " agent-anything ",
      path: " D:\\repo ",
    },
    provider: {
      profileId: " provider-a ",
      displayName: " Provider A ",
      endpointLabel: " provider.local ",
      model: " model-a ",
    },
    startedAt: "2026-06-30T08:00:00.000Z",
    endedAt: "2026-06-30T08:01:00.000Z",
    status: "completed" as const,
    activity: [{
      id: "activity-1",
      sequence: 1,
      timestamp: "2026-06-30T08:00:01.000Z",
      kind: "controller.started",
      title: "Planner started",
      detail: null,
      metadata: {},
    }],
    output: {
      taskId: "task-1",
      workspaceId: "workspace",
      agentSummary: "Updated docs.",
      runtimeStatus: "succeeded" as const,
      patchStatus: "applied" as const,
      appliedPath: "README.md",
      safeErrors: [],
    },
    patch: {
      proposalId: "proposal-1",
      operation: "update" as const,
      path: "README.md",
      summary: "Update docs.",
      decision: "accepted" as const,
      reason: "Accepted from test.",
      status: "applied" as const,
    },
    run: {
      runId: " run-1 ",
      status: "completed" as const,
      events: [{
        id: "event-1",
        sequence: 1,
        timestamp: "2026-06-30T08:00:01.000Z",
        kind: "planning.started" as const,
        title: "Planning started",
        detail: null,
        severity: "info" as const,
        metadata: {},
      }],
      terminal: {
        status: "completed" as const,
        runtimeStatus: "succeeded" as const,
        runtimeCode: null,
        cancellation: null,
        safeOutput: {
          taskId: "task-1",
          agentSummary: "Updated docs.",
        },
        errorSummary: [],
        startedAt: "2026-06-30T08:00:00.000Z",
        completedAt: "2026-06-30T08:01:00.000Z",
        eventCount: 1,
      },
    },
  };
}
