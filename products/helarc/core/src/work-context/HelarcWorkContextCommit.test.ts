import { describe, expect, it } from "vitest";
import {
  applyHelarcRunProgressCommit,
  applyHelarcRunStartCommit,
  applyHelarcRunTerminalCommit,
  normalizeHelarcThreadAggregate,
  type HelarcRunProgressCommit,
  type HelarcRunStartCommit,
  type HelarcRunTerminalCommit,
  type HelarcThreadAggregate,
} from "./HelarcWorkContextCommit.js";

const STARTED_AT = "2026-07-10T00:00:00.000Z";
const PROGRESS_AT = "2026-07-10T00:00:10.000Z";
const COMPLETED_AT = "2026-07-10T00:00:20.000Z";

describe("Helarc work context commit transitions", () => {
  it("atomically starts a Run and replays the exact commit idempotently", async () => {
    const commit = startCommit();
    const applied = await applyHelarcRunStartCommit(null, commit);
    expect(applied).toMatchObject({
      status: "applied",
      receipt: { committedThreadRevision: 1 },
      aggregate: {
        record: {
          thread: { revision: 1, latestRunId: "run-1" },
          messages: [{ id: "message-1", sequence: 1 }],
          runs: [{ id: "run-1", triggeringThreadRevision: 0 }],
          collaboration: [],
          reviews: [],
        },
        commitLedger: [{ expectedThreadRevision: 0, committedThreadRevision: 1 }],
      },
    });
    if (applied.status === "rejected") throw new Error(applied.message);

    const replay = await applyHelarcRunStartCommit(applied.aggregate, commit);
    expect(replay).toMatchObject({ status: "idempotent", receipt: { commitId: "commit-start-1" } });
    if (replay.status === "rejected") throw new Error(replay.message);
    expect(replay.aggregate).toBe(applied.aggregate);
  });

  it("rejects stale Thread revision and conflicting commit identity", async () => {
    const aggregate = await startedAggregate();
    const stale = progressCommit(1, 0, "commit-progress-stale");
    expect(await applyHelarcRunProgressCommit(aggregate, stale)).toMatchObject({
      status: "rejected",
      code: "stale_thread_revision",
    });

    const conflict = { ...startCommit(), committedAt: PROGRESS_AT };
    expect(await applyHelarcRunStartCommit(aggregate, conflict)).toMatchObject({
      status: "rejected",
      code: "commit_id_conflict",
    });
  });

  it("starts another Run directly in the existing Thread", async () => {
    const aggregate = await startedAggregate();
    const original = startCommit();
    const commit: HelarcRunStartCommit = {
      ...original,
      commitId: "commit-start-2",
      runId: "run-2",
      committedAt: PROGRESS_AT,
      expectedThreadRevision: 1,
      target: { kind: "existing_thread" },
      triggeringMessage: {
        ...original.triggeringMessage,
        id: "message-2",
        sequence: 2,
        content: "Continue.",
        correlation: { ...original.triggeringMessage.correlation, runId: "run-2" },
        createdAt: PROGRESS_AT,
        relatedRunIds: ["run-2"],
      },
      run: {
        ...original.run,
        id: "run-2",
        taskId: "task-2",
        triggeringMessageId: "message-2",
        triggeringThreadRevision: 1,
        startedAt: PROGRESS_AT,
        updatedAt: PROGRESS_AT,
      },
    };
    const result = await applyHelarcRunStartCommit(aggregate, commit);
    expect(result).toMatchObject({
      status: "applied",
      aggregate: {
        record: {
          thread: { revision: 2, latestRunId: "run-2" },
          messages: [{ id: "message-1" }, { id: "message-2", sequence: 2 }],
          runs: [{ id: "run-1" }, { id: "run-2", triggeringThreadRevision: 1 }],
        },
      },
    });
  });

  it("persists monotonic progress with one Thread revision per commit", async () => {
    const aggregate = await startedAggregate();
    const first = await applyHelarcRunProgressCommit(
      aggregate,
      progressCommit(1, 1, "commit-progress-1"),
    );
    expect(first).toMatchObject({
      status: "applied",
      receipt: { progressSequence: 1, committedThreadRevision: 2 },
      aggregate: {
        record: { thread: { revision: 2 }, runs: [{ progressSequence: 1 }] },
      },
    });
    if (first.status === "rejected") throw new Error(first.message);

    expect(await applyHelarcRunProgressCommit(
      first.aggregate,
      progressCommit(1, 2, "commit-progress-duplicate-sequence"),
    )).toMatchObject({ status: "rejected", code: "stale_progress" });
  });

  it("atomically settles terminal state, Message, and Artifact", async () => {
    const aggregate = await startedAggregate();
    const result = await applyHelarcRunTerminalCommit(aggregate, terminalCommit(1));
    expect(result).toMatchObject({
      status: "applied",
      receipt: { committedThreadRevision: 2 },
      aggregate: {
        record: {
          thread: { revision: 2 },
          messages: [{ id: "message-1" }, { id: "message-final", sequence: 2 }],
          runs: [{ terminal: { host: { status: "completed" } }, artifactIds: ["artifact-final"] }],
          artifacts: [{ id: "artifact-final", integrity: { status: "unverified" } }],
        },
      },
    });
    if (result.status === "rejected") throw new Error(result.message);
    expect(await applyHelarcRunTerminalCommit(result.aggregate, terminalCommit(1))).toMatchObject({
      status: "idempotent",
    });
  });

  it("rejects old aggregate shape and ledger revision discontinuity", async () => {
    const aggregate = await startedAggregate();
    const removedCollection = ["conver", "sations"].join("");
    const oldShape = {
      ...aggregate,
      record: { ...aggregate.record, [removedCollection]: [] },
    } as unknown as HelarcThreadAggregate;
    expect(normalizeHelarcThreadAggregate(oldShape)).toMatchObject({
      ok: false,
      error: { code: "aggregate_invalid" },
    });

    const brokenLedger = {
      ...aggregate,
      commitLedger: aggregate.commitLedger.map((entry) => ({
        ...entry,
        committedThreadRevision: 4,
      })),
    };
    expect(normalizeHelarcThreadAggregate(brokenLedger)).toMatchObject({
      ok: false,
      error: { code: "aggregate_invalid" },
    });
  });
});

async function startedAggregate(): Promise<HelarcThreadAggregate> {
  const result = await applyHelarcRunStartCommit(null, startCommit());
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
    expectedThreadRevision: 0,
    target: {
      kind: "create_thread",
      thread: {
        id: "thread-1",
        revision: 0,
        workspace: {
          primary: {
            profileId: "workspace-1",
            displayName: "AgentAnything",
            path: "D:/projects/agent-anything",
          },
          additional: [],
        },
        title: "Phase27",
        status: "open",
        createdAt: STARTED_AT,
        updatedAt: STARTED_AT,
        latestRunId: null,
        metadata: {},
      },
    },
    triggeringMessage: {
      id: "message-1",
      threadId: "thread-1",
      sequence: 1,
      role: "user",
      content: "Implement Phase27.",
      source: { kind: "user_input", owner: "desktop", refId: "input-1" },
      correlation: { runId: "run-1", interactionRequestId: null, reviewId: null },
      createdAt: STARTED_AT,
      relatedRunIds: ["run-1"],
      relatedArtifactIds: [],
      metadata: {},
    },
    run: {
      id: "run-1",
      harnessRunId: null,
      taskId: "task-1",
      sessionId: "session-1",
      threadId: "thread-1",
      triggeringMessageId: "message-1",
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

function progressCommit(
  progressSequence: number,
  expectedThreadRevision: number,
  commitId: string,
): HelarcRunProgressCommit {
  return {
    kind: "run_progress",
    commitId,
    threadId: "thread-1",
    runId: "run-1",
    committedAt: PROGRESS_AT,
    expectedThreadRevision,
    progressSequence,
    progress: {
      recordedAt: PROGRESS_AT,
      host: {
        sessionId: "session-1",
        taskId: "task-1",
        runId: "harness-run-1",
        sequence: progressSequence,
        runOperationSequence: progressSequence,
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
        sequence: progressSequence,
        phase: { kind: "none" },
        activity: [],
        result: null,
      },
    },
  };
}

function terminalCommit(expectedThreadRevision: number): HelarcRunTerminalCommit {
  return {
    kind: "run_terminal",
    commitId: "commit-terminal-1",
    threadId: "thread-1",
    runId: "run-1",
    committedAt: COMPLETED_AT,
    expectedThreadRevision,
    terminal: {
      host: {
        runId: "harness-run-1",
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
          runId: "harness-run-1",
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
        validation: {
          status: "not_required",
          snapshotRevision: 1,
          counts: [],
          activeChecks: 0,
          gateStatus: null,
          safeReasons: [],
          updatedAt: COMPLETED_AT,
        },
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
        id: "harness-run-1",
        revision: COMPLETED_AT,
      }],
      effectRefs: [],
      content: { kind: "inline", mediaType: "text/plain", value: "Done" },
      completeness: "complete",
      sensitivity: "private",
      freshness: { status: "current", observedAt: COMPLETED_AT, sourceRevision: COMPLETED_AT },
      integrity: { status: "unverified" },
      lifecycle: "final",
      persistence: "thread_record",
      limitations: [],
      createdAt: COMPLETED_AT,
    }],
  };
}
