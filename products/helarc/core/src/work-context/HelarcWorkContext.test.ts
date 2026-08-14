import { describe, expect, it } from "vitest";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import {
  createHelarcArtifact,
  createHelarcMessage,
  createHelarcPersistedRun,
  createHelarcThread,
  deriveHelarcPersistedRunStatus,
  normalizeHelarcThreadRecord,
  projectHelarcWorkspaceSelectionIdentity,
  type HelarcArtifact,
  type HelarcMessage,
  type HelarcPersistedRun,
  type HelarcThread,
  type HelarcThreadRecord,
} from "./index.js";

const NOW = "2026-07-09T00:00:00.000Z";

describe("Helarc work context domain", () => {
  it("creates normalized Thread, Message, Run, and engineering Artifact records", () => {
    expect(createHelarcThread({
      id: " thread-1 ",
      revision: 0,
      workspace: threadWorkspace(),
      title: " Implement Phase27 ",
      createdAt: NOW,
      updatedAt: NOW,
    })).toMatchObject({
      ok: true,
      thread: { id: "thread-1", revision: 0, title: "Implement Phase27", latestRunId: null },
    });

    expect(createHelarcMessage({
      id: " message-1 ",
      threadId: " thread-1 ",
      sequence: 1,
      role: "user",
      content: " Build work context ",
      source: { kind: "user_input", owner: " desktop ", refId: " input-1 " },
      correlation: { runId: " run-1 ", interactionRequestId: null, reviewId: null },
      createdAt: NOW,
      relatedRunIds: [" run-1 "],
      relatedArtifactIds: [],
    })).toMatchObject({
      ok: true,
      message: {
        id: "message-1",
        sequence: 1,
        content: "Build work context",
        source: { owner: "desktop", refId: "input-1" },
      },
    });

    expect(createHelarcPersistedRun({
      id: " run-1 ",
      taskId: " task-1 ",
      sessionId: " session-1 ",
      threadId: " thread-1 ",
      triggeringMessageId: " message-1 ",
      triggerMessageRole: "user",
      triggeringThreadRevision: 0,
      workspace: runWorkspace(),
      startedAt: NOW,
    })).toMatchObject({
      ok: true,
      run: { id: "run-1", triggeringThreadRevision: 0, permissionPreset: "ask_for_approval" },
    });

    expect(createHelarcArtifact(artifact())).toMatchObject({
      ok: true,
      artifact: {
        id: "artifact-1",
        completeness: "complete",
        integrity: { status: "unverified" },
        sourceRefs: [{ owner: "agent-core", kind: "run_result", id: "run-1" }],
      },
    });
  });

  it("normalizes one exact Thread aggregate with direct ordered relationships", () => {
    const result = normalizeHelarcThreadRecord(record());
    expect(result).toMatchObject({
      ok: true,
      record: {
        thread: { id: "thread-1", revision: 1, latestRunId: "run-1" },
        messages: [{ id: "message-1", sequence: 1 }],
        runs: [{ id: "run-1", triggeringThreadRevision: 0 }],
        artifacts: [],
        collaboration: [],
        reviews: [],
      },
    });
  });

  it("rejects the removed aggregate collection without migration", () => {
    const removedCollection = ["conver", "sations"].join("");
    const oldShape = {
      ...record(),
      [removedCollection]: [],
    } as unknown as HelarcThreadRecord;
    expect(normalizeHelarcThreadRecord(oldShape)).toMatchObject({
      ok: false,
      error: { code: "thread_record_invalid" },
    });
  });

  it("rejects non-contiguous Message ordering and dangling correlation", () => {
    const wrongSequence = record();
    wrongSequence.messages[0] = { ...wrongSequence.messages[0]!, sequence: 2 };
    expect(normalizeHelarcThreadRecord(wrongSequence)).toMatchObject({
      ok: false,
      error: { code: "thread_record_invalid" },
    });

    const danglingRun = record();
    danglingRun.messages[0] = {
      ...danglingRun.messages[0]!,
      relatedRunIds: ["missing-run"],
    };
    expect(normalizeHelarcThreadRecord(danglingRun)).toMatchObject({
      ok: false,
      error: { code: "thread_record_invalid" },
    });
  });

  it("requires Artifact provenance and does not infer correctness from existence", () => {
    expect(createHelarcArtifact({ ...artifact(), sourceRefs: [] as never })).toMatchObject({
      ok: false,
      error: { code: "artifact_contract_invalid" },
    });
    expect(createHelarcArtifact({
      ...artifact(),
      completeness: "unknown",
      integrity: { status: "unverified" },
      limitations: ["Validation was not evaluated."],
    })).toMatchObject({
      ok: true,
      artifact: {
        completeness: "unknown",
        integrity: { status: "unverified" },
        limitations: ["Validation was not evaluated."],
      },
    });
  });

  it("projects exact Workspace identity and derives inactive Run status", () => {
    const workspace: WorkspaceSelection = {
      primary: {
        id: "resolved-primary",
        name: "AgentAnything",
        rootRef: "workspace://primary",
        trustState: "trusted",
        metadata: {},
      },
      additional: [{
        id: "resolved-docs",
        name: "Docs",
        rootRef: "workspace://docs",
        trustState: "trusted",
        metadata: {},
      }],
    };
    expect(projectHelarcWorkspaceSelectionIdentity({
      workspace,
      threadWorkspace: threadWorkspace(),
    })).toEqual({
      primary: {
        workspaceId: "resolved-primary",
        profileId: "workspace-1",
        displayName: "AgentAnything",
      },
      additional: [{
        workspaceId: "resolved-docs",
        profileId: "workspace-docs",
        displayName: "Docs",
      }],
    });
    expect(deriveHelarcPersistedRunStatus(run())).toBe("inactive");
  });
});

function record(): HelarcThreadRecord {
  return {
    thread: thread(),
    messages: [message()],
    runs: [run()],
    artifacts: [],
    collaboration: [],
    reviews: [],
  };
}

function thread(): HelarcThread {
  return {
    id: "thread-1",
    revision: 1,
    workspace: threadWorkspace(),
    title: "Phase27",
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
    latestRunId: "run-1",
    metadata: {},
  };
}

function message(): HelarcMessage {
  return {
    id: "message-1",
    threadId: "thread-1",
    sequence: 1,
    role: "user",
    content: "Implement Phase27.",
    source: { kind: "user_input", owner: "desktop", refId: "input-1" },
    correlation: { runId: "run-1", interactionRequestId: null, reviewId: null },
    createdAt: NOW,
    relatedRunIds: ["run-1"],
    relatedArtifactIds: [],
    metadata: {},
  };
}

function run(): HelarcPersistedRun {
  return {
    id: "run-1",
    harnessRunId: null,
    taskId: "task-1",
    sessionId: "session-1",
    threadId: "thread-1",
    triggeringMessageId: "message-1",
    triggerMessageRole: "user",
    triggeringThreadRevision: 0,
    workspace: runWorkspace(),
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

function artifact(): HelarcArtifact {
  return {
    id: "artifact-1",
    threadId: "thread-1",
    runId: "run-1",
    kind: "final-output",
    title: "Final output",
    summary: "Done",
    producer: { kind: "agent", owner: "helarc", refId: "run-1" },
    sourceRefs: [{ owner: "agent-core", kind: "run_result", id: "run-1", revision: "1" }],
    effectRefs: [],
    content: { kind: "inline", mediaType: "text/plain", value: "Done" },
    completeness: "complete",
    sensitivity: "private",
    freshness: { status: "current", observedAt: NOW, sourceRevision: "1" },
    integrity: { status: "unverified" },
    lifecycle: "final",
    persistence: "thread_record",
    limitations: [],
    createdAt: NOW,
  };
}

function threadWorkspace() {
  return {
    primary: {
      profileId: "workspace-1",
      displayName: "AgentAnything",
      path: "D:/projects/agent-anything",
    },
    additional: [{
      profileId: "workspace-docs",
      displayName: "Docs",
      path: "D:/projects/agent-anything-docs",
    }],
  };
}

function runWorkspace() {
  return {
    primary: {
      workspaceId: "workspace-1",
      profileId: "workspace-1",
      displayName: "AgentAnything",
    },
    additional: [{
      workspaceId: "workspace-docs",
      profileId: "workspace-docs",
      displayName: "Docs",
    }],
  };
}
