import { describe, expect, it } from "vitest";
import {
  applyHelarcRunProgressCommit,
  applyHelarcRunStartCommit,
  applyHelarcRunTerminalCommit,
  type HelarcRunProgressCommit,
  type HelarcRunStartCommit,
  type HelarcRunTerminalCommit,
  type HelarcThreadAggregate,
} from "./HelarcWorkContextCommit.js";

const STARTED_AT = "2026-07-10T00:00:00.000Z";
const PROGRESS_AT = "2026-07-10T00:00:10.000Z";
const COMPLETED_AT = "2026-07-10T00:00:20.000Z";

describe("Helarc work context commit transitions", () => {
  it("atomically starts a Run in a new Thread and replays the exact commit idempotently", async () => {
    const commit = startCommit();
    const applied = await applyHelarcRunStartCommit(null, commit);

    expect(applied).toMatchObject({
      status: "applied",
      receipt: { kind: "run_start", progressSequence: 0 },
      aggregate: {
        record: {
          thread: { latestRunId: "run-1" },
          conversations: [{ messageIds: ["message-1"] }],
          messages: [{ id: "message-1" }],
          runs: [{ id: "run-1", terminal: null }],
        },
        commitLedger: [{ commitId: "commit-start-1" }],
      },
    });
    if (applied.status === "rejected") throw new Error("Expected start commit to apply.");

    const replay = await applyHelarcRunStartCommit(applied.aggregate, commit);
    expect(replay).toMatchObject({
      status: "idempotent",
      receipt: { commitId: "commit-start-1" },
    });
    if (replay.status === "rejected") throw new Error("Expected replay to settle.");
    expect(replay.aggregate).toBe(applied.aggregate);
  });

  it("rejects commit id reuse with different content without changing the aggregate", async () => {
    const aggregate = await startedAggregate();
    const conflicting = {
      ...startCommit(),
      committedAt: PROGRESS_AT,
    } satisfies HelarcRunStartCommit;

    const result = await applyHelarcRunStartCommit(aggregate, conflicting);
    expect(result).toMatchObject({ status: "rejected", code: "commit_id_conflict" });
    if (result.status !== "rejected") throw new Error("Expected commit conflict.");
    expect(result.aggregate).toBe(aggregate);
  });

  it("starts another Run in the existing active Conversation", async () => {
    const aggregate = await startedAggregate();
    const commit: HelarcRunStartCommit = {
      ...startCommit(),
      commitId: "commit-start-2",
      runId: "run-2",
      committedAt: PROGRESS_AT,
      target: { kind: "existing_thread", conversationId: "conversation-1" },
      triggeringMessage: {
        ...startCommit().triggeringMessage,
        id: "message-2",
        content: "Continue.",
        createdAt: PROGRESS_AT,
        relatedRunIds: ["run-2"],
      },
      run: {
        ...startCommit().run,
        id: "run-2",
        taskId: "task-2",
        triggeringMessageId: "message-2",
        startedAt: PROGRESS_AT,
        updatedAt: PROGRESS_AT,
      },
    };

    const result = await applyHelarcRunStartCommit(aggregate, commit);
    expect(result).toMatchObject({
      status: "applied",
      aggregate: {
        record: {
          thread: { latestRunId: "run-2" },
          conversations: [{ messageIds: ["message-1", "message-2"] }],
          runs: [{ id: "run-1" }, { id: "run-2" }],
        },
      },
    });
  });

  it("accepts ordered nonterminal progress and rejects stale progress", async () => {
    const aggregate = await startedAggregate();
    const first = progressCommit(1, "commit-progress-1");
    const applied = await applyHelarcRunProgressCommit(aggregate, first);
    expect(applied).toMatchObject({
      status: "applied",
      aggregate: { record: { runs: [{ progressSequence: 1 }] } },
    });
    if (applied.status === "rejected") throw new Error("Expected progress to apply.");

    const stale = await applyHelarcRunProgressCommit(
      applied.aggregate,
      progressCommit(1, "commit-progress-stale"),
    );
    expect(stale).toMatchObject({ status: "rejected", code: "stale_progress" });
    if (stale.status !== "rejected") throw new Error("Expected stale progress rejection.");
    expect(stale.aggregate).toBe(applied.aggregate);
  });

  it("atomically commits terminal truth, assistant Message, and Artifacts", async () => {
    const aggregate = await startedAggregate();
    const commit = terminalCommit();
    const result = await applyHelarcRunTerminalCommit(aggregate, commit);

    expect(result).toMatchObject({
      status: "applied",
      aggregate: {
        record: {
          conversations: [{ messageIds: ["message-1", "message-final"] }],
          messages: [{ id: "message-1" }, { id: "message-final" }],
          runs: [{
            id: "run-1",
            updatedAt: COMPLETED_AT,
            terminal: { platform: { status: "completed" }, product: { status: "completed" } },
            artifactIds: ["artifact-final"],
          }],
          artifacts: [{ id: "artifact-final", runId: "run-1" }],
        },
      },
    });
    if (result.status === "rejected") throw new Error("Expected terminal commit to apply.");

    const replay = await applyHelarcRunTerminalCommit(result.aggregate, commit);
    expect(replay).toMatchObject({ status: "idempotent" });
    if (replay.status === "rejected") throw new Error("Expected terminal replay to settle.");
    expect(replay.aggregate).toBe(result.aggregate);
  });

  it("keeps terminal Run state immutable", async () => {
    const aggregate = await terminalAggregate();
    const progress = await applyHelarcRunProgressCommit(
      aggregate,
      progressCommit(2, "commit-progress-after-terminal"),
    );
    expect(progress).toMatchObject({ status: "rejected", code: "run_terminal" });

    const secondTerminal = await applyHelarcRunTerminalCommit(aggregate, {
      ...terminalCommit(),
      commitId: "commit-terminal-2",
    });
    expect(secondTerminal).toMatchObject({ status: "rejected", code: "run_terminal" });
    if (secondTerminal.status !== "rejected") throw new Error("Expected terminal rejection.");
    expect(secondTerminal.aggregate).toBe(aggregate);
  });

  it("rejects unsafe commit data before applying domain changes", async () => {
    class UnsafeMetadata {}
    const commit: HelarcRunStartCommit = {
      ...startCommit(),
      run: { ...startCommit().run, metadata: new UnsafeMetadata() as never },
    };
    const result = await applyHelarcRunStartCommit(null, commit);
    expect(result).toMatchObject({ status: "rejected", code: "commit_invalid", aggregate: null });
  });
});

async function startedAggregate(): Promise<HelarcThreadAggregate> {
  const result = await applyHelarcRunStartCommit(null, startCommit());
  if (result.status === "rejected") throw new Error(result.message);
  return result.aggregate;
}

async function terminalAggregate(): Promise<HelarcThreadAggregate> {
  const result = await applyHelarcRunTerminalCommit(await startedAggregate(), terminalCommit());
  if (result.status === "rejected") throw new Error(result.message);
  return result.aggregate;
}

function startCommit(): HelarcRunStartCommit {
  return {
    kind: "run_start",
    commitId: "commit-start-1",
    threadId: "thread-1",
    runId: "run-1",
    committedAt: STARTED_AT,
    target: {
      kind: "create_thread",
      thread: {
        id: "thread-1",
        workspace: {
          profileId: "workspace-1",
          displayName: "AgentAnything",
          path: "D:/projects/agent-anything",
        },
        title: "Phase17",
        status: "open",
        createdAt: STARTED_AT,
        updatedAt: STARTED_AT,
        activeConversationId: "conversation-1",
        latestRunId: null,
        metadata: {},
      },
      conversation: {
        id: "conversation-1",
        threadId: "thread-1",
        createdAt: STARTED_AT,
        updatedAt: STARTED_AT,
        messageIds: [],
        metadata: {},
      },
    },
    triggeringMessage: {
      id: "message-1",
      threadId: "thread-1",
      conversationId: "conversation-1",
      role: "user",
      content: "Implement Phase17.",
      createdAt: STARTED_AT,
      relatedRunIds: ["run-1"],
      relatedArtifactIds: [],
      metadata: {},
    },
    run: {
      id: "run-1",
      taskId: "task-1",
      sessionId: "session-1",
      threadId: "thread-1",
      triggeringMessageId: "message-1",
      triggerMessageRole: "user",
      provider: null,
      permissionPreset: "ask_for_approval",
      startedAt: STARTED_AT,
      updatedAt: STARTED_AT,
      progressSequence: 0,
      lastProgress: null,
      terminal: null,
      artifactIds: [],
      metadata: {},
    },
  };
}

function progressCommit(sequence: number, commitId: string): HelarcRunProgressCommit {
  return {
    kind: "run_progress",
    commitId,
    threadId: "thread-1",
    runId: "run-1",
    committedAt: PROGRESS_AT,
    progressSequence: sequence,
    progress: {
      recordedAt: PROGRESS_AT,
      platform: {
        sessionId: "session-1",
        taskId: "task-1",
        runId: "run-1",
        sequence,
        status: "running",
        startedAt: STARTED_AT,
        plan: null,
        approval: null,
        retry: null,
        cancellation: null,
        enforcement: {
          selected: "disabled",
          status: "not_exercised",
          attemptCount: 0,
          escalationCount: 0,
          latestAttempt: null,
        },
        terminal: null,
      },
      product: {
        runId: "run-1",
        sequence,
        phase: { kind: "none" },
        activity: [],
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
    terminal: {
      platform: {
        runId: "run-1",
        taskId: "task-1",
        status: "completed",
        code: null,
        completedAt: COMPLETED_AT,
        durationMs: 20_000,
        iterations: 1,
        actions: 0,
        itemCount: 0,
        evidenceCount: 0,
        artifactCount: 1,
        errors: [],
        cancellation: null,
      },
      product: {
        status: "completed",
        output: {
          taskId: "task-1",
          workspaceId: "workspace-1",
          agentSummary: "Done",
          runtimeStatus: "succeeded",
          patchStatus: null,
          appliedPath: null,
          enforcement: { selected: "disabled", status: "not_exercised", code: null },
          safeErrors: [],
        },
      },
    },
    assistantMessage: {
      id: "message-final",
      threadId: "thread-1",
      conversationId: "conversation-1",
      role: "assistant",
      content: "Done.",
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
      createdAt: COMPLETED_AT,
      payload: { summary: "Done" },
      metadata: {},
    }],
  };
}
