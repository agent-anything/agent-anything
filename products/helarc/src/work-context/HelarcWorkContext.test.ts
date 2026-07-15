import { describe, expect, it } from "vitest";
import {
  createHelarcArtifact,
  createHelarcConversation,
  createHelarcMessage,
  createHelarcRun,
  createHelarcThread,
  normalizeHelarcThreadRecord,
  type HelarcThreadRecord,
} from "./HelarcWorkContext.js";

const NOW = "2026-07-09T00:00:00.000Z";

describe("Helarc work context domain", () => {
  it("creates normalized thread, conversation, message, run, and artifact records", () => {
    const thread = createHelarcThread({
      id: " thread-1 ",
      workspace: {
        profileId: " workspace-1 ",
        displayName: " AgentAnything ",
        path: " D:/projects/agent-anything ",
      },
      title: " Implement Phase11 ",
      createdAt: NOW,
      updatedAt: NOW,
      activeConversationId: " conversation-1 ",
    });

    expect(thread).toMatchObject({
      ok: true,
      thread: {
        id: "thread-1",
        title: "Implement Phase11",
        status: "open",
        activeConversationId: "conversation-1",
        workspace: {
          profileId: "workspace-1",
          displayName: "AgentAnything",
          path: "D:/projects/agent-anything",
        },
      },
    });

    const conversation = createHelarcConversation({
      id: " conversation-1 ",
      threadId: " thread-1 ",
      createdAt: NOW,
      updatedAt: NOW,
      messageIds: [" message-1 "],
    });

    expect(conversation).toMatchObject({
      ok: true,
      conversation: {
        id: "conversation-1",
        threadId: "thread-1",
        messageIds: ["message-1"],
      },
    });

    const message = createHelarcMessage({
      id: " message-1 ",
      threadId: " thread-1 ",
      conversationId: " conversation-1 ",
      role: "user",
      content: " Build work context ",
      createdAt: NOW,
    });

    expect(message).toMatchObject({
      ok: true,
      message: {
        id: "message-1",
        threadId: "thread-1",
        conversationId: "conversation-1",
        role: "user",
        content: "Build work context",
      },
    });

    const run = createHelarcRun({
      id: " run-1 ",
      threadId: " thread-1 ",
      triggeringMessageId: " message-1 ",
      triggerMessageRole: "user",
      status: "completed",
      provider: {
        profileId: " provider-1 ",
        providerKind: "ollama",
        displayName: " Local Ollama ",
        endpointLabel: " localhost:11434 ",
        model: " gemma3 ",
      },
      permissionPreset: "ask_for_approval",
      startedAt: NOW,
      completedAt: NOW,
      runtime: {
        status: "succeeded",
        code: " runtime_ok ",
        summary: " Done ",
      },
      artifactIds: [" artifact-1 "],
    });

    expect(run).toMatchObject({
      ok: true,
      run: {
        id: "run-1",
        threadId: "thread-1",
        triggeringMessageId: "message-1",
        triggerMessageRole: "user",
        status: "completed",
        provider: {
          profileId: "provider-1",
          providerKind: "ollama",
          displayName: "Local Ollama",
          endpointLabel: "localhost:11434",
          model: "gemma3",
        },
        runtime: {
          status: "succeeded",
          code: "runtime_ok",
          summary: "Done",
        },
        artifactIds: ["artifact-1"],
      },
    });

    const artifact = createHelarcArtifact({
      id: " artifact-1 ",
      threadId: " thread-1 ",
      runId: " run-1 ",
      kind: "final-output",
      title: " Final answer ",
      summary: " Completed ",
      createdAt: NOW,
      payload: { safe: true },
    });

    expect(artifact).toMatchObject({
      ok: true,
      artifact: {
        id: "artifact-1",
        threadId: "thread-1",
        runId: "run-1",
        kind: "final-output",
        title: "Final answer",
        summary: "Completed",
        payload: { safe: true },
      },
    });
  });

  it("requires every run to have a durable trigger message role", () => {
    expect(createHelarcRun({
      id: "run-1",
      threadId: "thread-1",
      triggeringMessageId: "message-1",
      triggerMessageRole: "assistant" as never,
      status: "starting",
      startedAt: NOW,
    })).toMatchObject({
      ok: false,
      error: { code: "run_trigger_message_role_invalid" },
    });

    expect(createHelarcRun({
      id: "run-1",
      threadId: "thread-1",
      triggeringMessageId: " ",
      triggerMessageRole: "user",
      status: "starting",
      startedAt: NOW,
    })).toMatchObject({
      ok: false,
      error: { code: "run_triggering_message_id_required" },
    });
  });

  it("normalizes a coherent thread record", () => {
    const record = createRecord();

    expect(normalizeHelarcThreadRecord(record)).toMatchObject({
      ok: true,
      record: {
        thread: {
          id: "thread-1",
          activeConversationId: "conversation-1",
          latestRun: {
            runId: "run-1",
            status: "completed",
          },
        },
        conversations: [{ id: "conversation-1", messageIds: ["message-1", "message-2"] }],
        messages: [
          { id: "message-1", role: "user" },
          { id: "message-2", role: "assistant", relatedRunIds: ["run-1"] },
        ],
        runs: [{ id: "run-1", triggeringMessageId: "message-1" }],
        artifacts: [{ id: "artifact-1", runId: "run-1" }],
      },
    });
  });

  it("rejects thread records with mismatched conversation message order", () => {
    const record = createRecord();
    record.conversations[0] = {
      ...record.conversations[0],
      messageIds: ["message-2", "message-1"],
    };

    expect(normalizeHelarcThreadRecord(record)).toMatchObject({
      ok: false,
      error: { code: "thread_record_invalid" },
    });
  });

  it("rejects runs whose trigger role does not match the triggering message", () => {
    const record = createRecord();
    record.runs[0] = {
      ...record.runs[0],
      triggerMessageRole: "product-event",
    };

    expect(normalizeHelarcThreadRecord(record)).toMatchObject({
      ok: false,
      error: { code: "thread_record_invalid" },
    });
  });

  it("rejects artifacts that reference unknown runs", () => {
    const record = createRecord();
    record.artifacts[0] = {
      ...record.artifacts[0],
      runId: "missing-run",
    };

    expect(normalizeHelarcThreadRecord(record)).toMatchObject({
      ok: false,
      error: { code: "thread_record_invalid" },
    });
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
      title: "Implement Phase11",
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
      activeConversationId: "conversation-1",
      latestRun: {
        runId: "run-1",
        status: "completed",
        startedAt: NOW,
        completedAt: NOW,
      },
      metadata: {},
    },
    conversations: [
      {
        id: "conversation-1",
        threadId: "thread-1",
        createdAt: NOW,
        updatedAt: NOW,
        messageIds: ["message-1", "message-2"],
        metadata: {},
      },
    ],
    messages: [
      {
        id: "message-1",
        threadId: "thread-1",
        conversationId: "conversation-1",
        role: "user",
        content: "Implement Phase11.",
        createdAt: NOW,
        relatedRunIds: ["run-1"],
        relatedArtifactIds: [],
        metadata: {},
      },
      {
        id: "message-2",
        threadId: "thread-1",
        conversationId: "conversation-1",
        role: "assistant",
        content: "Phase11 is complete.",
        createdAt: NOW,
        relatedRunIds: ["run-1"],
        relatedArtifactIds: ["artifact-1"],
        metadata: {},
      },
    ],
    runs: [
      {
        id: "run-1",
        threadId: "thread-1",
        triggeringMessageId: "message-1",
        triggerMessageRole: "user",
        status: "completed",
        provider: null,
        permissionPreset: "ask_for_approval",
        startedAt: NOW,
        completedAt: NOW,
        runtime: {
          status: "succeeded",
          code: null,
          summary: "Completed.",
        },
        errors: [],
        artifactIds: ["artifact-1"],
        metadata: {},
      },
    ],
    artifacts: [
      {
        id: "artifact-1",
        threadId: "thread-1",
        runId: "run-1",
        kind: "final-output",
        title: "Final answer",
        summary: "Completed.",
        createdAt: NOW,
        payload: { text: "Done" },
        metadata: {},
      },
    ],
  };
}
