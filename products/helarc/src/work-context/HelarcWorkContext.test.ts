import { describe, expect, it } from "vitest";
import {
  createHelarcArtifact,
  createHelarcConversation,
  createHelarcMessage,
  createHelarcPersistedRun,
  createHelarcThread,
  deriveHelarcPersistedRunStatus,
  normalizeHelarcThreadRecord,
  type HelarcPersistedRun,
  type HelarcThreadRecord,
} from "./HelarcWorkContext.js";

const NOW = "2026-07-09T00:00:00.000Z";
const LATER = "2026-07-09T00:01:00.000Z";

describe("Helarc work context domain", () => {
  it("creates normalized initial Thread, Conversation, Message, Run, and Artifact records", () => {
    expect(createHelarcThread({
      id: " thread-1 ",
      workspace: {
        profileId: " workspace-1 ",
        displayName: " AgentAnything ",
        path: " D:/projects/agent-anything ",
      },
      title: " Implement Phase17 ",
      createdAt: NOW,
      updatedAt: NOW,
      activeConversationId: " conversation-1 ",
    })).toMatchObject({
      ok: true,
      thread: {
        id: "thread-1",
        title: "Implement Phase17",
        latestRunId: null,
      },
    });

    expect(createHelarcConversation({
      id: " conversation-1 ",
      threadId: " thread-1 ",
      createdAt: NOW,
      updatedAt: NOW,
      messageIds: [" message-1 "],
    })).toMatchObject({
      ok: true,
      conversation: { id: "conversation-1", messageIds: ["message-1"] },
    });

    expect(createHelarcMessage({
      id: " message-1 ",
      threadId: " thread-1 ",
      conversationId: " conversation-1 ",
      role: "user",
      content: " Build work context ",
      createdAt: NOW,
    })).toMatchObject({
      ok: true,
      message: { id: "message-1", role: "user", content: "Build work context" },
    });

    expect(createHelarcPersistedRun({
      id: " run-1 ",
      taskId: " task-1 ",
      sessionId: " session-1 ",
      threadId: " thread-1 ",
      triggeringMessageId: " message-1 ",
      triggerMessageRole: "user",
      provider: {
        profileId: " provider-1 ",
        providerKind: "ollama",
        displayName: " Local Ollama ",
        endpointLabel: " localhost:11434 ",
        model: " gemma3 ",
      },
      permissionPreset: "ask_for_approval",
      startedAt: NOW,
    })).toMatchObject({
      ok: true,
      run: {
        id: "run-1",
        taskId: "task-1",
        sessionId: "session-1",
        updatedAt: NOW,
        progressSequence: 0,
        lastProgress: null,
        terminal: null,
        artifactIds: [],
      },
    });

    expect(createHelarcArtifact({
      id: " artifact-1 ",
      threadId: " thread-1 ",
      runId: " run-1 ",
      kind: "final-output",
      title: " Final answer ",
      summary: " Completed ",
      createdAt: NOW,
      payload: { safe: true },
    })).toMatchObject({
      ok: true,
      artifact: { id: "artifact-1", runId: "run-1", payload: { safe: true } },
    });
  });

  it("requires durable Run source identities and a valid trigger role", () => {
    expect(createHelarcPersistedRun({
      id: "run-1",
      taskId: "task-1",
      sessionId: "session-1",
      threadId: "thread-1",
      triggeringMessageId: "message-1",
      triggerMessageRole: "assistant" as never,
      startedAt: NOW,
    })).toMatchObject({ ok: false, error: { code: "run_trigger_message_role_invalid" } });

    expect(createHelarcPersistedRun({
      id: "run-1",
      taskId: " ",
      sessionId: "session-1",
      threadId: "thread-1",
      triggeringMessageId: "message-1",
      triggerMessageRole: "user",
      startedAt: NOW,
    })).toMatchObject({ ok: false, error: { code: "run_task_id_required" } });
  });

  it("derives persisted status from terminal source truth", () => {
    const inactive = createRecord().runs[0];
    expect(deriveHelarcPersistedRunStatus(inactive)).toBe("inactive");

    const completed = terminalRun("completed", "completed");
    expect(deriveHelarcPersistedRunStatus(completed)).toBe("completed");

    const rejected = terminalRun("completed", "rejected");
    expect(deriveHelarcPersistedRunStatus(rejected)).toBe("rejected");

    const failed = terminalRun("failed", "failed");
    expect(deriveHelarcPersistedRunStatus(failed)).toBe("failed");
  });

  it("normalizes a coherent durable Thread record", () => {
    const record = createRecord();
    expect(normalizeHelarcThreadRecord(record)).toMatchObject({
      ok: true,
      record: {
        thread: { id: "thread-1", latestRunId: "run-1" },
        conversations: [{ messageIds: ["message-1"] }],
        messages: [{ id: "message-1", role: "user" }],
        runs: [{ id: "run-1", taskId: "task-1", terminal: null }],
      },
    });
  });

  it("rejects incoherent relationships and unsafe durable payloads", () => {
    const wrongOrder = createRecord();
    wrongOrder.conversations[0] = { ...wrongOrder.conversations[0], messageIds: [] };
    expect(normalizeHelarcThreadRecord(wrongOrder)).toMatchObject({
      ok: false,
      error: { code: "thread_record_invalid" },
    });

    const unknownLatest = createRecord();
    unknownLatest.thread = { ...unknownLatest.thread, latestRunId: "missing-run" };
    expect(normalizeHelarcThreadRecord(unknownLatest)).toMatchObject({
      ok: false,
      error: { code: "thread_record_invalid" },
    });

    class UnsafePayload {}
    expect(createHelarcArtifact({
      id: "artifact-unsafe",
      threadId: "thread-1",
      kind: "trace-projection",
      title: "Unsafe",
      createdAt: NOW,
      payload: new UnsafePayload() as never,
    })).toMatchObject({ ok: false });
  });
});

function createRecord(): HelarcThreadRecord {
  return {
    thread: {
      id: "thread-1",
      workspace: {
        profileId: "workspace-1",
        displayName: "AgentAnything",
        path: "D:/projects/agent-anything",
      },
      title: "Implement Phase17",
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
      activeConversationId: "conversation-1",
      latestRunId: "run-1",
      metadata: {},
    },
    conversations: [{
      id: "conversation-1",
      threadId: "thread-1",
      createdAt: NOW,
      updatedAt: NOW,
      messageIds: ["message-1"],
      metadata: {},
    }],
    messages: [{
      id: "message-1",
      threadId: "thread-1",
      conversationId: "conversation-1",
      role: "user",
      content: "Implement Phase17.",
      createdAt: NOW,
      relatedRunIds: ["run-1"],
      relatedArtifactIds: [],
      metadata: {},
    }],
    runs: [initialRun()],
    artifacts: [],
  };
}

function initialRun(): HelarcPersistedRun {
  return {
    id: "run-1",
    taskId: "task-1",
    sessionId: "session-1",
    threadId: "thread-1",
    triggeringMessageId: "message-1",
    triggerMessageRole: "user",
    provider: null,
    permissionPreset: "ask_for_approval",
    startedAt: NOW,
    updatedAt: NOW,
    progressSequence: 0,
    lastProgress: null,
    terminal: null,
    artifactIds: [],
    metadata: {},
  };
}

function terminalRun(
  platformStatus: "completed" | "failed",
  productStatus: "completed" | "rejected" | "failed",
): HelarcPersistedRun {
  return {
    ...initialRun(),
    updatedAt: LATER,
    terminal: {
      platform: {
        runId: "run-1",
        taskId: "task-1",
        status: platformStatus,
        code: platformStatus === "completed" ? null : "runtime_error",
        completedAt: LATER,
        durationMs: 60_000,
        iterations: 1,
        actions: 0,
        itemCount: 0,
        evidenceCount: 0,
        artifactCount: 0,
        errors: [],
        cancellation: null,
      },
      product: {
        status: productStatus,
        output: {
          taskId: "task-1",
          workspaceId: "workspace-1",
          agentSummary: "Done",
          runtimeStatus: platformStatus === "completed" ? "succeeded" : "failed",
          patchStatus: null,
          appliedPath: null,
          enforcement: { selected: "disabled", status: "not_exercised", code: null },
          safeErrors: [],
        },
      },
    },
  };
}
