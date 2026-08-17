import type {
  HelarcRunProgressCommit,
  HelarcRunStartCommit,
  HelarcRunTerminalCommit,
} from "@agent-anything/helarc/work-context";
import {
  mkdtemp,
  readFile,
  readdir,
  rename as renameFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileHelarcThreadStore,
  HelarcThreadStoreCorruptionError,
} from "./FileHelarcThreadStore.js";

const STARTED_AT = "2026-07-18T00:00:00.000Z";
const PROGRESS_AT = "2026-07-18T00:00:10.000Z";
const COMPLETED_AT = "2026-07-18T00:00:20.000Z";

describe("FileHelarcThreadStore", () => {
  it("persists a versioned aggregate and restores Renderer-safe queries", async () => {
    const filePath = await threadFilePath();
    const store = new FileHelarcThreadStore(filePath);

    const result = await store.commitRunStart(startCommit("1"));

    expect(result).toMatchObject({ status: "applied" });
    await expect(store.loadThread("thread-1")).resolves.toMatchObject({
      thread: { id: "thread-1", latestRunId: "run-1" },
      runs: [{ id: "run-1", terminal: null }],
    });
    await expect(store.listThreadSummaries()).resolves.toMatchObject([{
      id: "thread-1",
      latestRun: { runId: "run-1", status: "inactive" },
    }]);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      formatVersion: 2,
      aggregates: [{ commitLedger: [{ commitId: "commit-start-1" }] }],
    });
  });

  it("serializes different Threads across Store instances sharing one file", async () => {
    const filePath = await threadFilePath();
    const firstStore = new FileHelarcThreadStore(filePath);
    const secondStore = new FileHelarcThreadStore(filePath);

    const [first, second] = await Promise.all([
      firstStore.commitRunStart(startCommit("1")),
      secondStore.commitRunStart(startCommit("2")),
    ]);

    expect(first.status).toBe("applied");
    expect(second.status).toBe("applied");
    await expect(firstStore.listThreadSummaries()).resolves.toHaveLength(2);
    await expect(firstStore.loadThread("thread-1")).resolves.not.toBeNull();
    await expect(firstStore.loadThread("thread-2")).resolves.not.toBeNull();
  });

  it("serializes progress commits and rejects stale progress without rewriting", async () => {
    const filePath = await threadFilePath();
    let replacementCount = 0;
    const store = new FileHelarcThreadStore(filePath, {
      operations: {
        async replace(sourcePath, targetPath) {
          replacementCount += 1;
          await renameFile(sourcePath, targetPath);
        },
      },
    });
    await store.commitRunStart(startCommit("1"));

    const [first, second] = await Promise.all([
      store.commitRunProgress(progressCommit(1, "commit-progress-1")),
      store.commitRunProgress(progressCommit(2, "commit-progress-2", "2026-07-18T00:00:11.000Z")),
    ]);
    const stale = await store.commitRunProgress(
      progressCommit(1, "commit-progress-stale", "2026-07-18T00:00:12.000Z", 3),
    );

    expect(first.status).toBe("applied");
    expect(second.status).toBe("applied");
    expect(stale).toMatchObject({ status: "rejected", code: "stale_progress" });
    expect(replacementCount).toBe(3);
    await expect(store.loadThread("thread-1")).resolves.toMatchObject({
      runs: [{ progressSequence: 2 }],
    });
  });

  it("returns exact replay idempotently without replacing the file", async () => {
    const filePath = await threadFilePath();
    let replacementCount = 0;
    const store = new FileHelarcThreadStore(filePath, {
      operations: {
        async replace(sourcePath, targetPath) {
          replacementCount += 1;
          await renameFile(sourcePath, targetPath);
        },
      },
    });
    const commit = startCommit("1");

    await expect(store.commitRunStart(commit)).resolves.toMatchObject({ status: "applied" });
    await expect(store.commitRunStart(commit)).resolves.toMatchObject({ status: "idempotent" });
    expect(replacementCount).toBe(1);
  });

  it("commits terminal source truth, Message, and Artifacts in one replacement", async () => {
    const filePath = await threadFilePath();
    const store = new FileHelarcThreadStore(filePath);
    await store.commitRunStart(startCommit("1"));

    const result = await store.commitRunTerminal(terminalCommit());

    expect(result).toMatchObject({ status: "applied" });
    await expect(store.loadThread("thread-1")).resolves.toMatchObject({
      messages: [{ id: "message-1" }, { id: "message-final" }],
      runs: [{
        terminal: { host: { status: "completed" }, product: { status: "completed" } },
        artifactIds: ["artifact-final"],
      }],
      artifacts: [{ id: "artifact-final", runId: "run-1" }],
    });
  });

  it("does not rewrite exact terminal replay or rejected post-terminal commits", async () => {
    const filePath = await threadFilePath();
    let replacementCount = 0;
    const store = new FileHelarcThreadStore(filePath, {
      operations: {
        async replace(sourcePath, targetPath) {
          replacementCount += 1;
          await renameFile(sourcePath, targetPath);
        },
      },
    });
    const terminal = terminalCommit();
    await store.commitRunStart(startCommit("1"));
    await store.commitRunTerminal(terminal);

    await expect(store.commitRunTerminal(terminal)).resolves.toMatchObject({
      status: "idempotent",
    });
    await expect(store.commitRunTerminal({
      ...terminal,
      commitId: "commit-terminal-conflict",
      expectedThreadRevision: 2,
    })).resolves.toMatchObject({ status: "rejected", code: "run_terminal" });
    await expect(store.commitRunProgress(
      progressCommit(
        1,
        "commit-progress-after-terminal",
        "2026-07-18T00:00:30.000Z",
        2,
      ),
    )).resolves.toMatchObject({ status: "rejected", code: "run_terminal" });
    expect(replacementCount).toBe(2);
  });

  it("preserves the prior target and throws when atomic replacement fails", async () => {
    const filePath = await threadFilePath();
    const workingStore = new FileHelarcThreadStore(filePath);
    await workingStore.commitRunStart(startCommit("1"));
    const before = await readFile(filePath, "utf8");
    const failingStore = new FileHelarcThreadStore(filePath, {
      createTemporaryId: () => "injected-failure",
      operations: {
        async replace() {
          throw new Error("injected rename failure");
        },
      },
    });

    await expect(failingStore.commitRunProgress(
      progressCommit(1, "commit-progress-failed"),
    )).rejects.toThrow("injected rename failure");

    expect(await readFile(filePath, "utf8")).toBe(before);
    expect(await readdir(dirname(filePath))).toEqual(["threads.json"]);
    await expect(workingStore.loadThread("thread-1")).resolves.toMatchObject({
      runs: [{ progressSequence: 0 }],
    });
  });

  it("fails closed for invalid JSON, old format, and malformed ledgers", async () => {
    const filePath = await threadFilePath();
    await writeFile(filePath, "{invalid", "utf8");
    await expect(new FileHelarcThreadStore(filePath).listThreadSummaries()).rejects
      .toBeInstanceOf(HelarcThreadStoreCorruptionError);

    await writeFile(filePath, "[]", "utf8");
    await expect(new FileHelarcThreadStore(filePath).listThreadSummaries()).rejects
      .toBeInstanceOf(HelarcThreadStoreCorruptionError);

    await writeFile(filePath, JSON.stringify({
      formatVersion: 1,
      aggregates: [{ commitLedger: [] }],
    }), "utf8");
    await expect(new FileHelarcThreadStore(filePath).listThreadSummaries()).rejects
      .toBeInstanceOf(HelarcThreadStoreCorruptionError);

    const store = new FileHelarcThreadStore(filePath);
    await writeFile(filePath, JSON.stringify({ formatVersion: 2, aggregates: [] }), "utf8");
    await store.commitRunStart(startCommit("1"));
    const valid = JSON.parse(await readFile(filePath, "utf8"));
    const malformed = structuredClone(valid);
    malformed.aggregates[0].commitLedger[0].fingerprint = "sha256:invalid";
    await writeFile(filePath, JSON.stringify(malformed), "utf8");
    await expect(store.loadThread("thread-1")).rejects
      .toBeInstanceOf(HelarcThreadStoreCorruptionError);

    await writeFile(filePath, JSON.stringify({
      formatVersion: 2,
      aggregates: [valid.aggregates[0], valid.aggregates[0]],
    }), "utf8");
    await expect(store.listThreadSummaries()).rejects
      .toBeInstanceOf(HelarcThreadStoreCorruptionError);
  });

  it("retains the aggregate accepted by the current commit", async () => {
    const filePath = await threadFilePath();
    const store = new FileHelarcThreadStore(filePath, { maxThreads: 1 });
    await store.commitRunStart(startCommit("1", "2026-07-18T00:01:00.000Z"));
    await store.commitRunStart(startCommit("2", STARTED_AT));

    await expect(store.loadThread("thread-2")).resolves.not.toBeNull();
    await expect(store.loadThread("thread-1")).resolves.toBeNull();
  });
});

async function threadFilePath(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "helarc-atomic-thread-store-"));
  return join(rootPath, "threads.json");
}

function startCommit(id: string, timestamp = STARTED_AT): HelarcRunStartCommit {
  return {
    kind: "run_start",
    commitId: `commit-start-${id}`,
    threadId: `thread-${id}`,
    runId: `run-${id}`,
    committedAt: timestamp,
    expectedThreadRevision: 0,
    target: {
      kind: "create_thread",
      thread: {
        id: `thread-${id}`,
        revision: 0,
        workspace: {
          primary: {
            profileId: "workspace-1",
            displayName: "AgentAnything",
            path: "D:/projects/agent-anything",
          },
          additional: [],
        },
        title: `Thread ${id}`,
        status: "open",
        createdAt: timestamp,
        updatedAt: timestamp,
        latestRunId: null,
        metadata: {},
      },
    },
    triggeringMessage: {
      id: `message-${id}`,
      threadId: `thread-${id}`,
      sequence: 1,
      role: "user",
      content: `Task ${id}`,
      source: { kind: "user_input", owner: "desktop", refId: `input-${id}` },
      correlation: {
        runId: `run-${id}`,
        interactionRequestId: null,
        reviewId: null,
      },
      createdAt: timestamp,
      relatedRunIds: [`run-${id}`],
      relatedArtifactIds: [],
      metadata: {},
    },
    run: {
      id: `run-${id}`,
      harnessRunId: null,
      taskId: `task-${id}`,
      sessionId: `session-${id}`,
      threadId: `thread-${id}`,
      triggeringMessageId: `message-${id}`,
      triggerMessageRole: "user",
      triggeringThreadRevision: 0,
      workspace: {
        primary: {
          workspaceId: "workspace-1",
          profileId: "workspace-1",
          displayName: "AgentAnything",
        },
        additional: [],
      },
      provider: null,
      permissionPreset: "ask_for_approval",
      startedAt: timestamp,
      updatedAt: timestamp,
      progressSequence: 0,
      lastProgress: null,
      terminal: null,
      artifactIds: [],
      metadata: {},
    },
  };
}

function progressCommit(
  sequence: number,
  commitId: string,
  timestamp = PROGRESS_AT,
  expectedThreadRevision = sequence,
): HelarcRunProgressCommit {
  return {
    kind: "run_progress",
    commitId,
    threadId: "thread-1",
    runId: "run-1",
    committedAt: timestamp,
    expectedThreadRevision,
    progressSequence: sequence,
    progress: {
      recordedAt: timestamp,
      host: {
        sessionId: "session-1",
        taskId: "task-1",
        runId: "run-1",
        sequence,
        runOperationSequence: sequence,
        runRevision: 0,
        status: "running",
        startedAt: STARTED_AT,
        plan: null,
        pendingInteractions: [],
        retry: null,
        cancellation: null,
        enforcement: {
          selected: "disabled",
          status: "not_exercised",
          attemptCount: 0,
          latestAttempt: null,
        },
        terminal: null,
      },
      product: {
        runId: "run-1",
        sequence,
        phase: { kind: "none" },
        activity: [],
        continuation: null,
        result: null,
      },
    },
  };
}

function terminalCommit(): HelarcRunTerminalCommit {
  return {
    kind: "run_terminal",
    commitId: "commit-terminal-1",
    threadId: "thread-1",
    runId: "run-1",
    committedAt: COMPLETED_AT,
    expectedThreadRevision: 1,
    terminal: {
      host: {
        runId: "run-1",
        taskId: "task-1",
        status: "completed",
        code: null,
        completedAt: COMPLETED_AT,
        durationMs: 20_000,
        itemCount: 0,
        evidenceCount: 0,
        artifactCount: 1,
        failure: null,
        relatedFailures: [],
        cancellation: null,
      },
      product: {
        status: "completed",
        runResult: {
          runId: "run-1",
          status: "succeeded",
          code: null,
          startedAt: STARTED_AT,
          completedAt: COMPLETED_AT,
        },
        output: {
          taskId: "task-1",
          workspace: { primaryId: "workspace-1", additionalIds: [] },
          agentSummary: "Done",
          runtimeStatus: "succeeded",
          patchStatus: null,
          appliedPath: null,
          enforcement: { selected: "disabled", status: "not_exercised", code: null },
          safeErrors: [],
        },
        runActions: [],
        effects: [],
        actions: [],
        composites: [],
        children: [],
        interactions: [],
        validation: { status: "not_evaluated", assessments: [] },
        uncertainty: [],
        residualRisk: [],
        incompleteWork: [],
        nextActions: [],
        artifactRefs: [],
      },
    },
    assistantMessage: {
      id: "message-final",
      threadId: "thread-1",
      sequence: 2,
      role: "assistant",
      content: "Done.",
      source: { kind: "agent_run", owner: "helarc", refId: "run-1" },
      correlation: { runId: "run-1", interactionRequestId: null, reviewId: null },
      createdAt: COMPLETED_AT,
      relatedRunIds: ["run-1"],
      relatedArtifactIds: ["artifact-final"],
      metadata: {},
    },
    artifacts: [{
      id: "artifact-final",
      threadId: "thread-1",
      runId: "run-1",
      kind: "final-output",
      title: "Final output",
      summary: "Done",
      producer: { kind: "agent", owner: "helarc", refId: "run-1" },
      sourceRefs: [{
        owner: "agent-core",
        kind: "run_result",
        id: "run-1",
        revision: COMPLETED_AT,
      }],
      effectRefs: [],
      content: { kind: "inline", mediaType: "text/plain", value: "Done" },
      completeness: "complete",
      sensitivity: "private",
      freshness: {
        status: "current",
        observedAt: COMPLETED_AT,
        sourceRevision: COMPLETED_AT,
      },
      integrity: { status: "unverified" },
      lifecycle: "final",
      persistence: "thread_record",
      limitations: [],
      createdAt: COMPLETED_AT,
    }],
  };
}
