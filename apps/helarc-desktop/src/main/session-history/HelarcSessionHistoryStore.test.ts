import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileHelarcSessionHistoryStore } from "./HelarcSessionHistoryStore.js";

describe("FileHelarcSessionHistoryStore", () => {
  it("persists session history records across store recreation", async () => {
    const filePath = await historyFilePath();
    const store = new FileHelarcSessionHistoryStore(filePath);

    await store.appendRecord(record("history-1", "2026-06-30T08:00:00.000Z"));

    const restored = new FileHelarcSessionHistoryStore(filePath);
    await expect(restored.listRecords()).resolves.toMatchObject([
      {
        id: "history-1",
        taskText: "Update docs",
        workspace: { displayName: "workspace" },
        provider: { displayName: "Provider" },
      },
    ]);
  });

  it("sorts records by end timestamp and replaces duplicate ids", async () => {
    const store = new FileHelarcSessionHistoryStore(await historyFilePath());

    await store.appendRecord(record("history-1", "2026-06-30T08:00:00.000Z"));
    await store.appendRecord(record("history-2", "2026-06-30T09:00:00.000Z"));
    const records = await store.appendRecord({
      ...record("history-1", "2026-06-30T10:00:00.000Z"),
      taskText: "Updated task",
    });

    expect(records.map((item) => item.id)).toEqual(["history-1", "history-2"]);
    expect(records[0]?.taskText).toBe("Updated task");
  });

  it("skips malformed records when reading history", async () => {
    const filePath = await historyFilePath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify([
      record("history-1", "2026-06-30T08:00:00.000Z"),
      { id: "", taskText: "" },
    ]), "utf8");

    const store = new FileHelarcSessionHistoryStore(filePath);
    await expect(store.listRecords()).resolves.toHaveLength(1);
  });
});

async function historyFilePath(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "helarc-session-history-"));
  return join(rootPath, "history", "sessions.json");
}

function record(id: string, endedAt: string) {
  return {
    id,
    taskId: "task-1",
    taskText: "Update docs",
    workspace: {
      profileId: "workspace:a",
      displayName: "workspace",
      path: "D:\\repo",
    },
    provider: {
      profileId: "provider-a",
      displayName: "Provider",
      endpointLabel: "provider.local",
      model: "model-a",
    },
    startedAt: "2026-06-30T07:59:00.000Z",
    endedAt,
    status: "completed" as const,
    activity: [],
    output: {
      taskId: "task-1",
      workspaceId: "workspace",
      agentSummary: "Done.",
      runtimeStatus: "succeeded" as const,
      patchStatus: null,
      appliedPath: null,
      safeErrors: [],
    },
    patch: {
      patchId: null,
      operation: null,
      path: null,
      summary: null,
      decision: "not_required" as const,
      reason: null,
      status: null,
    },
  };
}
