import { describe, expect, it } from "vitest";
import type { HelarcRunProjection } from "@agent-anything/helarc/run";
import type { HelarcThreadRecord } from "@agent-anything/helarc/work-context";
import type { HelarcHostActiveRun } from "../run/HelarcHostRunComposition.js";
import { HelarcWorkbenchQueries } from "./HelarcWorkbenchQueries.js";
import { CommandOutputRegistry } from "./CommandOutputRegistry.js";

const scope = { threadId: "thread", productRunId: "work", runId: "root" };
function fixture() {
  const p = {
    productRunId: "work",
    harnessRunId: "root",
    host: {
      runId: "root",
      sequence: 1,
      status: "running",
      terminal: null,
      enforcement: { selected: "disabled" },
      pendingInteractions: [],
      retry: null,
      runTree: {
        nodes: [
          {
            runId: "root",
            parentRunId: null,
            status: "running",
            terminal: null,
          },
          {
            runId: "child",
            parentRunId: "root",
            status: "running",
            terminal: null,
          },
        ],
      },
    },
    product: {
      runId: "work",
      sequence: 1,
      result: null,
      qualification: {},
      continuation: null,
      commands: [],
      responses: {
        revision: 0,
        omittedAttempts: 0,
        retainedBytes: 0,
        attempts: [],
      },
      presentation: {
        revision: 0,
        nextSequence: 1,
        omittedRecords: 0,
        retainedBytes: 0,
        records: [],
        activeCalls: [],
        omittedActiveCalls: 0,
        labels: [
          {
            runId: "root",
            parentRunId: null,
            parentRunActionId: null,
            label: "Root",
            objective: "Task",
          },
        ],
        plans: {},
        sourceSequences: {},
      },
    },
    display: { status: "running", terminal: false, statusSource: "host" },
  } as unknown as HelarcRunProjection;
  const thread = {
    thread: { id: "thread", revision: 1 },
    messages: [
      {
        id: "user",
        sequence: 1,
        role: "user",
        content: "Task",
        source: { kind: "user_input" },
        correlation: { runId: "work" },
        metadata: {},
        relatedArtifactIds: [],
      },
    ],
    runs: [
      {
        id: "work",
        harnessRunId: "root",
        triggeringMessageId: "user",
        startedAt: "2026-09-22T00:00:00Z",
        updatedAt: "2026-09-22T00:00:00Z",
        terminal: null,
        lastProjection: { ...p, recordedAt: "2026-09-22T00:00:00Z" },
        provider: { displayName: "Bound model provider", model: "bound-model" },
        permissionPreset: "ask_for_approval",
      },
    ],
    artifacts: [],
  } as unknown as HelarcThreadRecord;
  let live = true;
  const api = new HelarcWorkbenchQueries({
    loadThread: async (id) => (id === scope.threadId ? thread : null),
    live: (id, work) =>
      live && id === scope.threadId && work === scope.productRunId
        ? {
            projection: p,
            handle: {
              getResponsePreviews: () => p.product.responses,
            } as HelarcHostActiveRun,
          }
        : null,
    outputs: new CommandOutputRegistry(),
  });
  return {
    p,
    thread,
    api,
    retain: () => {
      live = false;
    },
  };
}
function textRecord(
  sequence: number,
  runId = "root",
  text = `message-${sequence}`,
) {
  return {
    id: `text-${runId}-${sequence}`,
    runId,
    sequence,
    revision: sequence,
    observedAt: "2026-09-22T00:00:00Z",
    source: {
      owner: "runtime" as const,
      kind: "run_item" as const,
      id: `item-${sequence}`,
      sequence,
    },
    content: {
      kind: "assistant_text" as const,
      turnId: `turn-${sequence}`,
      modelItemId: `model-${sequence}`,
      ordinal: 0,
      text,
      omittedBytes: 0,
    },
  };
}
describe("collaboration reads", () => {
  it("reads the latest root content directly, keeps older anchors on append and suppresses final source globally", async () => {
    const { p, thread, api } = fixture();
    const records = Array.from({ length: 240 }, (_, i) => textRecord(i + 1));
    Object.assign(p.product.presentation, {
      records: [...records, textRecord(241, "child", "child-private-context")],
      nextSequence: 242,
    });
    const latest = await api.readConversation({
      threadId: "thread",
      position: { kind: "latest" },
    });
    expect(latest.status).toBe("page");
    if (latest.status !== "page") return;
    expect(latest.entries).toHaveLength(100);
    expect(latest.entries.at(-1)?.content).toBe("message-240");
    expect(JSON.stringify(latest)).not.toContain("child-private-context");
    records.push(textRecord(242));
    Object.assign(p.product.presentation, { records });
    const older = await api.readConversation({
      threadId: "thread",
      position: { kind: "before", cursor: latest.previousCursor! },
    });
    expect(older.status).toBe("page");
    if (older.status !== "page") return;
    expect(older.entries.at(-1)?.content).toBe("message-140");
    thread.messages.push({
      ...thread.messages[0]!,
      id: "final",
      sequence: 2,
      role: "assistant",
      content: "final reply",
      source: { kind: "agent_run", owner: "helarc", refId: "work" },
      metadata: {
        outputSource: {
          kind: "model_text",
          turnId: "turn-240",
          modelItemIds: ["model-240", "model-1"],
        },
      },
    });
    const final = await api.readConversation({
      threadId: "thread",
      position: { kind: "latest" },
    });
    expect(final.status).toBe("page");
    if (final.status !== "page") return;
    expect(final.entries.at(-1)?.content).toBe("final reply");
    expect(final.entries.some((e) => e.sourceId === "text-root-240")).toBe(
      false,
    );
    const originalTail = await api.readConversation({
      threadId: "thread",
      position: { kind: "before", cursor: older.previousCursor! },
    });
    expect(originalTail.status).toBe("page");
    if (originalTail.status === "page")
      expect(
        originalTail.entries.some((e) => e.sourceId === "text-root-1"),
      ).toBe(false);
    Object.assign(p.product.presentation, { omittedRecords: 1 });
    expect(
      await api.readConversation({
        threadId: "thread",
        position: { kind: "before", cursor: latest.previousCursor! },
      }),
    ).toMatchObject({ code: "stale_cursor" });
  });
  it("keeps attention and active work separate from history with bound rather than current configuration", async () => {
    const { p, api } = fixture();
    Object.assign(p.host, {
      pendingInteractions: [
        {
          runId: "child",
          request: { id: "approval", requestVersion: 1 },
          phase: "pending",
        },
      ],
    });
    Object.assign(p.product.presentation, {
      omittedRecords: 200,
      omittedActiveCalls: 3,
      activeCalls: [
        {
          ...textRecord(1),
          content: {
            kind: "tool_call",
            name: "Read",
            callId: "call",
            turnId: "turn",
            input: { path: "file" },
            runActionId: null,
            invocationId: null,
            settlement: null,
            result: null,
          },
        },
      ],
    });
    const current = await api.readCurrentWork(scope);
    expect(current).toMatchObject({
      status: "page",
      attention: [{ runId: "child", request: { id: "approval" } }],
      activeCalls: [{ content: { name: "Read" } }],
      context: {
        model: "bound-model",
        permissionPreset: "ask_for_approval",
        effectiveGrants: "not_projected",
      },
      omitted: { calls: 3 },
    });
    expect(
      await api.readCurrentWork({ ...scope, productRunId: "elsewhere" }),
    ).toMatchObject({ code: "not_found" });
    expect(
      await api.readTaskDetails({ ...scope, runId: "elsewhere" }),
    ).toMatchObject({ code: "not_found" });
  });
  it("bounds complete envelopes even with large escaped content and keeps independent history cursors", async () => {
    const { p, api } = fixture();
    Object.assign(p.product.presentation, {
      records: Array.from({ length: 150 }, (_, i) =>
        textRecord(i + 1, "root", '"\\\n'.repeat(30000)),
      ),
    });
    const page = await api.readConversation({
      threadId: "thread",
      position: { kind: "latest" },
    });
    expect(page.status).toBe("page");
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      256 * 1024,
    );
    const history = await api.readWorkHistory({
      ...scope,
      collection: "assistant",
      cursor: null,
    });
    expect(history.status).toBe("page");
    if (history.status !== "page") return;
    expect(history.records.at(-1)?.sequence).toBe(150);
    expect(history.previousCursor).not.toBeNull();
    expect(
      await api.readWorkHistory({
        ...scope,
        collection: "operations",
        cursor: history.previousCursor,
      }),
    ).toMatchObject({ code: "stale_cursor" });
  });
  it("pages current collections independently from settled history and rejects changed collection cursors", async () => {
    const { p, api } = fixture();
    const calls = Array.from({ length: 240 }, (_, i) => ({
      ...textRecord(i + 1),
      content: {
        kind: "tool_call",
        name: "Read",
        callId: `call-${i}`,
        turnId: "turn",
        input: { path: `file-${i}` },
        runActionId: null,
        invocationId: null,
        settlement: null,
        result: null,
      },
    }));
    Object.assign(p.product.presentation, { activeCalls: calls });
    const first = await api.readCurrentWork(scope);
    expect(first.status).toBe("page");
    if (first.status !== "page") return;
    expect(first.activeCalls.length).toBeLessThan(240);
    expect(first.nextCursors.calls).not.toBeNull();
    Object.assign(p.product.presentation, { records: [textRecord(999)] });
    const next = await api.readCurrentWork({
      ...scope,
      collection: "calls",
      cursor: first.nextCursors.calls,
    });
    expect(next.status).toBe("page");
    if (next.status !== "page") return;
    expect(
      [...first.activeCalls, ...next.activeCalls].map((c) => c.id),
    ).toEqual(calls.map((c) => c.id));
    expect(next.tasks).toEqual([]);
    expect(next.nextCursors.calls).toBeNull();
    expect(
      await api.readCurrentWork({
        ...scope,
        collection: "tasks",
        cursor: first.nextCursors.calls,
      }),
    ).toMatchObject({ code: "stale_cursor" });
    calls.pop();
    expect(
      await api.readCurrentWork({
        ...scope,
        collection: "calls",
        cursor: first.nextCursors.calls,
      }),
    ).toMatchObject({ code: "stale_cursor" });
  });
  it("reads retained conversation text through its owned detail reference", async () => {
    const { thread, api } = fixture();
    Object.assign(thread.messages[0]!, { content: "\u{1F642}".repeat(30000) });
    const page = await api.readConversation({
      threadId: "thread",
      position: { kind: "latest" },
    });
    expect(page.status).toBe("page");
    if (page.status !== "page") return;
    const detail = page.entries[0]!.detail!;
    expect(detail).toMatchObject({ itemId: "message:user", runId: "root" });
    const first = await api.readWorkbenchItem(detail);
    expect(first.status).toBe("page");
    if (first.status !== "page") return;
    expect(first.text.endsWith("\u{1F642}")).toBe(true);
    expect(first.nextOffset).not.toBeNull();
    expect(
      await api.readWorkbenchItem({ ...detail, runId: "child" }),
    ).toMatchObject({ code: "not_found" });
    expect(await api.readWorkbenchItem({ ...detail, offset: 1 })).toMatchObject(
      { code: "invalid_query" },
    );
    Object.assign(thread.messages[0]!, { content: "\u0000".repeat(40000) });
    const escaped = await api.readWorkbenchItem(detail);
    expect(escaped.status).toBe("page");
    expect(Buffer.byteLength(JSON.stringify(escaped))).toBeLessThanOrEqual(
      64 * 1024,
    );
  });
  it("only discloses owned safe inline Artifacts and binds cursors to content revisions", async () => {
    const { thread, api } = fixture();
    const a = {
      id: "artifact",
      threadId: "thread",
      runId: "work",
      content: {
        kind: "inline",
        mediaType: "text/plain",
        value: "\u{1F642}".repeat(40000),
      },
      kind: "final-output",
      title: "Retained text",
      summary: null,
      producer: { kind: "agent", owner: "helarc", refId: "root" },
      sourceRefs: [
        { owner: "runtime", kind: "run", id: "root", revision: null },
      ],
      effectRefs: [],
      freshness: { status: "unknown", observedAt: null },
      lifecycle: "final",
      persistence: "thread_record",
      createdAt: "2026-09-22T00:00:00Z",
      sensitivity: "private",
      completeness: "partial",
      integrity: { status: "unverified" },
      limitations: ["Partial retained text"],
    } satisfies HelarcThreadRecord["artifacts"][number];
    thread.artifacts.push(a);
    const first = await api.readArtifactContent({
      threadId: "thread",
      artifactId: a.id,
      cursor: null,
    });
    expect(first.status).toBe("page");
    if (first.status !== "page") return;
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(64 * 1024);
    expect(first.text.endsWith("\u{1F642}")).toBe(true);
    expect(
      await api.readArtifactContent({
        threadId: "other",
        artifactId: a.id,
        cursor: null,
      }),
    ).toMatchObject({ code: "not_found" });
    Object.assign(a, {
      content: { kind: "inline", mediaType: "text/plain", value: "changed" },
    });
    expect(
      await api.readArtifactContent({
        threadId: "thread",
        artifactId: a.id,
        cursor: first.nextCursor,
      }),
    ).toMatchObject({ code: "stale_cursor" });
    Object.assign(a, {
      content: {
        kind: "inline",
        mediaType: "text/plain",
        value: "\u0000".repeat(40000),
      },
    });
    const escaped = await api.readArtifactContent({
      threadId: "thread",
      artifactId: a.id,
      cursor: null,
    });
    expect(escaped.status).toBe("page");
    expect(Buffer.byteLength(JSON.stringify(escaped))).toBeLessThanOrEqual(
      64 * 1024,
    );
    Object.assign(a, { sensitivity: "secret" });
    expect(
      await api.readArtifactContent({
        threadId: "thread",
        artifactId: a.id,
        cursor: null,
      }),
    ).toMatchObject({ reason: "restricted" });
    Object.assign(a, {
      sensitivity: "private",
      content: { kind: "reference", uri: "file:///secret" },
    });
    expect(
      await api.readArtifactContent({
        threadId: "thread",
        artifactId: a.id,
        cursor: null,
      }),
    ).toMatchObject({ reason: "unsupported_reference" });
    Object.assign(a, {
      content: {
        kind: "inline",
        mediaType: "application/json",
        value: {
          password: "hidden",
          items: Array.from({ length: 1000 }, () => "x".repeat(500)),
        },
      },
    });
    const structured = await api.readArtifactContent({
      threadId: "thread",
      artifactId: a.id,
      cursor: null,
    });
    expect(structured.status).toBe("page");
    if (structured.status === "page") {
      expect(JSON.parse(structured.text)).toHaveProperty("items");
      expect(structured.projected).toBe(true);
      expect(structured.text).not.toContain("hidden");
    }
  });
  it("resynchronizes exact root/Child attempts and marks unclosed retained previews inactive", async () => {
    const { p, api, retain } = fixture();
    const attempt = {
      runId: "root",
      requestId: "request",
      controllerRequestId: "controller",
      invocationId: "attempt",
      revision: 1,
      deliverySequence: 2,
      mode: "streaming",
      state: "receiving",
      code: null,
      parts: [
        {
          id: "text:0",
          kind: "text",
          text: "a".repeat(20000),
          receivedLength: 20000,
          omittedBytes: 0,
          name: null,
          modelItemId: null,
          turnId: null,
          committedRecordId: null,
        },
      ],
    };
    Object.assign(p.product.responses, {
      revision: 1,
      attempts: [
        attempt,
        { ...attempt, runId: "child", invocationId: "child-attempt" },
      ],
    });
    const first = await api.readResponsePreview({
      ...scope,
      invocationId: "attempt",
      cursor: null,
    });
    expect(first.status).toBe("page");
    if (first.status !== "page") return;
    expect(first.attempts).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    Object.assign(p.product.responses, { revision: 2 });
    attempt.parts[0]!.text += "more";
    const next = await api.readResponsePreview({
      ...scope,
      invocationId: "attempt",
      cursor: first.nextCursor,
    });
    expect(next.status).toBe("page");
    if (next.status === "page")
      expect(next.attempts[0]?.parts[0]?.offset).toBe(8192);
    expect(
      await api.readResponsePreview({
        ...scope,
        runId: "child",
        invocationId: "attempt",
        cursor: null,
      }),
    ).toMatchObject({ code: "not_found" });
    retain();
    const reopened = await api.readResponsePreview({
      ...scope,
      invocationId: "attempt",
      cursor: null,
    });
    expect(reopened).toMatchObject({
      status: "page",
      live: false,
      attempts: [{ state: "inactive" }],
    });
  });
});
