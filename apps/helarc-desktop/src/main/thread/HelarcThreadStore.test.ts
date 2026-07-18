import type {
  HelarcArtifact,
  HelarcMessage,
  HelarcThreadRecord,
  HelarcPersistedRun,
} from "@agent-anything/helarc";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileHelarcThreadStore } from "./HelarcThreadStore.js";

const STARTED_AT = "2026-07-09T08:00:00.000Z";
const UPDATED_AT = "2026-07-09T08:01:00.000Z";
const COMPLETED_AT = "2026-07-09T08:02:00.000Z";

describe("FileHelarcThreadStore", () => {
  it("persists thread records across store recreation", async () => {
    const filePath = await threadFilePath();
    const store = new FileHelarcThreadStore(filePath);

    const created = await store.createThread(record("thread-1", STARTED_AT));

    expect(created).toMatchObject({
      thread: {
        id: "thread-1",
        title: "Implement Phase11",
      },
      conversations: [{ id: "conversation-thread-1" }],
      messages: [{ id: "message-thread-1", role: "user" }],
    });

    const restored = new FileHelarcThreadStore(filePath);
    await expect(restored.loadThread("thread-1")).resolves.toMatchObject({
      thread: {
        id: "thread-1",
        workspace: { displayName: "AgentAnything" },
      },
    });
  });

  it("lists thread summaries sorted by update timestamp and replaces duplicate ids", async () => {
    const store = new FileHelarcThreadStore(await threadFilePath());

    await store.createThread(record("thread-1", STARTED_AT));
    await store.createThread(record("thread-2", UPDATED_AT));
    await store.createThread({
      ...record("thread-1", COMPLETED_AT),
      thread: {
        ...record("thread-1", COMPLETED_AT).thread,
        title: "Updated title",
      },
    });

    const summaries = await store.listThreadSummaries();

    expect(summaries.map((summary) => summary.id)).toEqual(["thread-1", "thread-2"]);
    expect(summaries[0]).toMatchObject({
      id: "thread-1",
      title: "Updated title",
      workspace: { displayName: "AgentAnything" },
    });
  });

  it("skips malformed records while reading persisted threads", async () => {
    const filePath = await threadFilePath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify([
      record("thread-1", STARTED_AT),
      { thread: { id: "" }, conversations: [] },
    ]), "utf8");

    const store = new FileHelarcThreadStore(filePath);
    await expect(store.listThreadSummaries()).resolves.toHaveLength(1);
  });

  it("appends messages and keeps conversation message order", async () => {
    const store = new FileHelarcThreadStore(await threadFilePath());
    await store.createThread(record("thread-1", STARTED_AT));

    const updated = await store.appendMessage("thread-1", assistantMessage("thread-1"));

    expect(updated).toMatchObject({
      thread: {
        id: "thread-1",
        updatedAt: UPDATED_AT,
      },
      conversations: [
        {
          id: "conversation-thread-1",
          messageIds: ["message-thread-1", "assistant-thread-1"],
        },
      ],
      messages: [
        { id: "message-thread-1", role: "user" },
        { id: "assistant-thread-1", role: "assistant" },
      ],
    });
  });

  it("appends and updates runs under a valid trigger message", async () => {
    const store = new FileHelarcThreadStore(await threadFilePath());
    await store.createThread(record("thread-1", STARTED_AT));

    const inactive = await store.appendRun("thread-1", run("thread-1", null));
    expect(inactive).toMatchObject({
      thread: {
        latestRunId: "run-thread-1",
      },
      runs: [{ id: "run-thread-1", terminal: null }],
    });

    const completed = await store.updateRun("thread-1", run("thread-1", COMPLETED_AT));
    expect(completed).toMatchObject({
      thread: {
        updatedAt: COMPLETED_AT,
        latestRunId: "run-thread-1",
      },
      runs: [{ id: "run-thread-1", terminal: { platform: { status: "completed" } } }],
    });

    await expect(store.listThreadSummaries()).resolves.toMatchObject([{
      latestRun: {
        runId: "run-thread-1",
        status: "completed",
        completedAt: COMPLETED_AT,
      },
    }]);
  });

  it("appends artifacts and links them to their run", async () => {
    const store = new FileHelarcThreadStore(await threadFilePath());
    await store.createThread(record("thread-1", STARTED_AT));
    await store.appendRun("thread-1", run("thread-1", COMPLETED_AT));

    const updated = await store.appendArtifact("thread-1", artifact("thread-1"));

    expect(updated).toMatchObject({
      runs: [
        {
          id: "run-thread-1",
          artifactIds: ["artifact-thread-1"],
        },
      ],
      artifacts: [
        {
          id: "artifact-thread-1",
          runId: "run-thread-1",
          kind: "final-output",
        },
      ],
    });
  });

  it("rejects invalid thread updates without overwriting stored data", async () => {
    const store = new FileHelarcThreadStore(await threadFilePath());
    await store.createThread(record("thread-1", STARTED_AT));

    await expect(store.appendRun("thread-1", {
      ...run("thread-1", null),
      triggerMessageRole: "product-event",
    })).resolves.toBeNull();

    await expect(store.loadThread("thread-1")).resolves.toMatchObject({
      runs: [],
      thread: {
        latestRunId: null,
      },
    });
  });
});

async function threadFilePath(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "helarc-thread-store-"));
  return join(rootPath, "threads", "threads.json");
}

function record(threadId: string, updatedAt: string): HelarcThreadRecord {
  const conversationId = `conversation-${threadId}`;
  const messageId = `message-${threadId}`;

  return {
    thread: {
      id: threadId,
      workspace: {
        profileId: "workspace-1",
        displayName: "AgentAnything",
        path: "D:/projects/agent-anything",
      },
      title: "Implement Phase11",
      status: "open",
      createdAt: STARTED_AT,
      updatedAt,
      activeConversationId: conversationId,
      latestRunId: null,
      metadata: {},
    },
    conversations: [
      {
        id: conversationId,
        threadId,
        createdAt: STARTED_AT,
        updatedAt,
        messageIds: [messageId],
        metadata: {},
      },
    ],
    messages: [
      {
        id: messageId,
        threadId,
        conversationId,
        role: "user",
        content: "Implement Phase11.",
        createdAt: STARTED_AT,
        relatedRunIds: [],
        relatedArtifactIds: [],
        metadata: {},
      },
    ],
    runs: [],
    artifacts: [],
  };
}

function assistantMessage(threadId: string): HelarcMessage {
  return {
    id: `assistant-${threadId}`,
    threadId,
    conversationId: `conversation-${threadId}`,
    role: "assistant",
    content: "Done.",
    createdAt: UPDATED_AT,
    relatedRunIds: [],
    relatedArtifactIds: [],
    metadata: {},
  };
}

function run(
  threadId: string,
  completedAt: string | null,
): HelarcPersistedRun {
  return {
    id: `run-${threadId}`,
    taskId: `task-${threadId}`,
    sessionId: threadId,
    threadId,
    triggeringMessageId: `message-${threadId}`,
    triggerMessageRole: "user",
    provider: {
      profileId: "provider-1",
      providerKind: "ollama",
      displayName: "Local Ollama",
      endpointLabel: "localhost:11434",
      model: "gemma3",
    },
    permissionPreset: "ask_for_approval",
    startedAt: STARTED_AT,
    updatedAt: completedAt ?? STARTED_AT,
    progressSequence: 0,
    lastProgress: null,
    terminal: completedAt === null ? null : {
      platform: {
        runId: `run-${threadId}`,
        taskId: `task-${threadId}`,
        status: "completed",
        code: null,
        completedAt,
        durationMs: 120_000,
        iterations: 1,
        actions: 0,
        itemCount: 0,
        evidenceCount: 0,
        artifactCount: 0,
        errors: [],
        cancellation: null,
      },
      product: null,
    },
    artifactIds: [],
    metadata: {},
  };
}

function artifact(threadId: string): HelarcArtifact {
  return {
    id: `artifact-${threadId}`,
    threadId,
    runId: `run-${threadId}`,
    kind: "final-output",
    title: "Final answer",
    summary: "Completed.",
    createdAt: COMPLETED_AT,
    payload: {
      text: "Done.",
    },
    metadata: {},
  };
}
