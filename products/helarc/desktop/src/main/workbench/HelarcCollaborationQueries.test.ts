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
  it("routes interaction Tools to forms and attributed conversation facts rather than execution", async () => {
    const { p, api, retain } = fixture();
    const protocol = { owner: "helarc", kind: "clarification", revision: "1" };
    const question = callRecord("question", "child", "RenamedQuestion", {});
    Object.assign(question.content, { toolBindingKind: "interaction", interactionProtocol: protocol,
      input: { questions: [{ id: "q1", prompt: "Include spaces?" }, { id: "q2", prompt: "Output name?" }] } });
    const ordinary = callRecord("ordinary", "root", "AskUserQuestion", {});
    Object.assign(p.product.presentation, { records: [question, ordinary], activeCalls: [question, ordinary] });
    Object.assign(p.host, { pendingInteractions: [{ runId: "child", request: { id: "request", protocol }, phase: "pending" }] });
    const current = await api.readCurrentWork(scope);
    expect(current.status).toBe("page");
    if (current.status !== "page") return;
    expect(current.activeCalls.map(r => r.id)).toEqual(["ordinary"]);
    expect(current.attention).toHaveLength(1);
    expect(current.activity.current.map(i => i.id)).toEqual(["call:root:ordinary"]);
    expect(await api.readWorkbenchItem({ ...scope, runId: "child", itemId: "question" })).toMatchObject({ code: "not_found" });
    const before = await api.readConversation({ threadId: "thread", position: { kind: "latest" } });
    if (before.status === "page") expect(before.entries.filter(e => e.kind === "interaction")).toEqual([]);

    Object.assign(question.content, { settlement: "succeeded", result: { kind: "interaction", status: "resolved", value: {
      answers: [{ question_id: "q2", selected_labels: [], text: "Counts" }, { question_id: "q1", selected_labels: ["Yes"], text: null }],
    } } });
    Object.assign(p.product.presentation, { activeCalls: [ordinary] });
    Object.assign(p.host, { pendingInteractions: [] });
    retain();
    const conversation = await api.readConversation({ threadId: "thread", position: { kind: "latest" } });
    expect(conversation.status).toBe("page");
    if (conversation.status !== "page") return;
    const exchange = conversation.entries.find(e => e.kind === "interaction");
    expect(exchange).toMatchObject({ runId: "child", title: "Question", disposition: "Answered" });
    expect(exchange?.content).toContain("From: Subtask\n\nInclude spaces?\nYour answer:\nYes\n\nOutput name?\nYour answer:\nCounts");
    expect(await api.readWorkbenchItem({ ...scope, runId: "child", itemId: "question" })).toMatchObject({ status: "page", title: "Question", text: exchange?.content });
    expect(await api.readWorkbenchItem({ ...scope, itemId: "question" })).toMatchObject({ code: "not_found" });
    expect(await api.readWorkHistory({ ...scope, runId: "child", collection: "operations", cursor: null })).toMatchObject({ records: [] });
    expect(await api.readCurrentWork(scope)).toMatchObject({ retainedFinishedCount: 0, activity: { recent: [] } });

    Object.assign(question.content, { settlement: "failed", result: { kind: "interaction", status: "expired", value: { code: "interaction_expired" } } });
    const expired = await api.readConversation({ threadId: "thread", position: { kind: "latest" } });
    if (expired.status === "page") {
      const item = expired.entries.find(e => e.kind === "interaction");
      expect(item).toMatchObject({ disposition: "Expired" });
      expect(item?.content).toContain("Include spaces?");
      expect(item?.content).not.toContain("Your answer:");
    }
    Object.assign(question.content, { result: { kind: "tool_rejected", code: "tool_input_invalid" } });
    expect(await api.readWorkbenchItem({ ...scope, runId: "child", itemId: "question" })).toMatchObject({ status: "page", text: expect.stringContaining("could not proceed") });
    Object.assign(question.content, { result: null });
    expect(await api.readWorkbenchItem({ ...scope, runId: "child", itemId: "question" })).toMatchObject({ text: expect.stringContaining("outcome details are unavailable") });
  });
  it("routes controls to their feature view by binding kind across activity, history, counts and details", async () => {
    const { p, api, retain } = fixture();
    const control = callRecord("control", "root", "update_plan", {});
    Object.assign(control.content, { callableKind: "control", name: "Read_alias" });
    const tool = callRecord("ordinary", "root", "update_plan", {});
    const unknown = callRecord("unknown", "root", "update_plan", {});
    Object.assign(unknown.content, { callableKind: "unresolved", resolvedName: null });
    const plan = { steps: [{ step: "Inspect files", status: "in_progress" }] };
    Object.assign(p.product.presentation, { records: [control, tool, unknown], activeCalls: [control, tool, unknown], plans: { root: plan } });
    const source = JSON.stringify(p.product.presentation);
    const active = await api.readCurrentWork(scope);
    expect(active.status).toBe("page");
    if (active.status !== "page") return;
    expect(active.activeCalls.map(r => r.id)).toEqual(["ordinary", "unknown"]);
    expect(active.activity.current.filter(i => i.kind === "operation").map(i => i.id)).toEqual(["call:root:ordinary", "call:root:unknown"]);
    expect(active.plan).toEqual(plan);
    expect(active.retainedFinishedCount).toBe(0);
    expect(await api.readWorkbenchItem({ ...scope, itemId: "control" })).toMatchObject({ code: "not_found" });
    expect(await api.readWorkbenchItem({ ...scope, itemId: "ordinary" })).toMatchObject({ status: "operation" });
    expect(await api.readWorkbenchItem({ ...scope, itemId: "unknown" })).toMatchObject({ detail: { title: "Model call" } });
    expect(JSON.stringify(p.product.presentation)).toBe(source);

    Object.assign(control.content, { settlement: "succeeded", result: { kind: "plan_update" } });
    Object.assign(p.product.presentation, { activeCalls: [tool, unknown] });
    const controlOnly = await api.readCurrentWork(scope);
    expect(controlOnly).toMatchObject({ retainedFinishedCount: 0, activity: { recent: [] }, tasks: [
      { runId: "root", hasPlan: true, hasFinishedWork: false }, expect.anything(),
    ] });

    for (const record of [tool, unknown]) Object.assign(record.content, { settlement: "failed" });
    Object.assign(p.product.presentation, { activeCalls: [] });
    retain();
    const history = await api.readWorkHistory({ ...scope, collection: "operations", cursor: null });
    expect(history.status).toBe("page");
    if (history.status === "page") expect(history.records.map(r => r.id)).toEqual(["ordinary", "unknown"]);
    const settled = await api.readCurrentWork(scope);
    expect(settled).toMatchObject({ retainedFinishedCount: 2, plan });
    if (settled.status === "page") expect(settled.activity.recent.map(i => i.id)).toEqual(["call:root:ordinary", "call:root:unknown"]);
    expect(p.product.presentation.records.find(r => r.id === "control")?.content).toMatchObject({ callableKind: "control", settlement: "succeeded" });
  });
  it("projects concrete concurrent activity without equating outstanding calls to executing commands", async () => {
    const { p, api } = fixture();
    Object.assign(p.product.presentation, { activeCalls: [
      callRecord("shell", "root", "PowerShell", { command: "dotnet build" }, "invocation"),
      callRecord("read", "child", "Read", { file_path: "src/Program.cs" }),
    ] });
    Object.assign(p.product, { commands: [commandRecord()] });
    const page = await api.readCurrentWork(scope);
    expect(page.status).toBe("page");
    if (page.status !== "page") return;
    expect(page.activity.current).toMatchObject([
      { kind: "command", title: "dotnet build", status: "Running" },
      { kind: "operation", title: "Read file: src/Program.cs", status: "Result pending", attribution: "Subtask" },
    ]);
    expect(page.activity.current.filter(i => i.title.includes("dotnet build"))).toHaveLength(1);
    expect(page.activity.current.every(i => !("input" in i) && !("result" in i))).toBe(true);
    Object.assign(p.product, { commands: [] });
    const before = await api.readCurrentWork(scope);
    expect(before).toMatchObject({ activity: { current: [
      { kind: "operation", title: "PowerShell command: dotnet build", status: "Result pending" }, expect.anything(),
    ] } });
  });
  it("does not join sibling invocations or use task-level attention to misclassify an active command", async () => {
    const { p, api } = fixture();
    Object.assign(p.product.presentation, { activeCalls: [
      callRecord("shell", "child", "PowerShell", { command: "other command" }, "invocation"),
    ] });
    Object.assign(p.product, { commands: [commandRecord()] });
    Object.assign(p.host, { pendingInteractions: [{ runId: "root", request: { id: "approval" }, phase: "pending" }] });
    const page = await api.readCurrentWork(scope);
    expect(page).toMatchObject({ activity: { current: [
      { kind: "command", status: "Running" }, { kind: "operation", status: "Result pending" },
      { kind: "attention", state: "waiting" },
    ] } });
  });
  it.each(["running", "waiting", "suspended", "cancelling"])("keeps %s task lifecycle in task summaries, not activity", async status => {
    const { p, api } = fixture();
    Object.assign(p.host, { status });
    for (const node of p.host.runTree.nodes) Object.assign(node, { status });
    const page = await api.readCurrentWork(scope);
    expect(page).toMatchObject({ activity: { current: [], recent: [], omittedCurrent: 0 }, tasks: [
      { runId: "root", status }, { runId: "child", status },
    ] });
  });
  it("keeps delegation hierarchy out of activity while preserving concrete child work", async () => {
    const { p, api } = fixture();
    Object.assign(p.host.runTree.nodes[1]!, { parentRunActionId: "delegate-action" });
    const call = callRecord("delegate", "root", "Agent", { description: "Inspect dependencies", prompt: "PRIVATE PROMPT" });
    Object.assign(call.content, { runActionId: "delegate-action" });
    Object.assign(p.product.presentation, { activeCalls: [call], labels: [
      ...p.product.presentation.labels, { runId: "child", parentRunId: "root", parentRunActionId: "delegate-action", label: "Inspect dependencies", objective: "PRIVATE PROMPT" },
    ] });
    const page = await api.readCurrentWork(scope);
    expect(page).toMatchObject({ activity: { current: [] }, tasks: [
      { runId: "root" }, { runId: "child", parentRunId: "root", label: "Inspect dependencies" },
    ] });
    if (page.status === "page") expect(JSON.stringify(page.activity)).not.toContain("PRIVATE PROMPT");
    Object.assign(p.host, { status: "waiting" });
    Object.assign(p.host.runTree.nodes[0]!, { status: "waiting" });
    Object.assign(p.product.presentation, { activeCalls: [call, callRecord("read", "child", "Read", { file_path: "package.json" })] });
    expect(await api.readCurrentWork(scope)).toMatchObject({ activity: { current: [
      { kind: "operation", title: "Read file: package.json", attribution: "Inspect dependencies" },
    ] } });
  });
  it("uses response facts and never resurrects ended or inactive work as live", async () => {
    const { p, api, retain } = fixture();
    Object.assign(p.product.responses, { attempts: [{ runId: "child", invocationId: "response", state: "receiving", parts: [] }] });
    expect(await api.readCurrentWork(scope)).toMatchObject({ activity: { current: [
      { kind: "response", title: "Waiting for model response" },
    ] } });
    Object.assign(p.host.runTree.nodes[1]!, { status: "completed" });
    expect(await api.readCurrentWork(scope)).toMatchObject({ activity: { current: [] } });
    Object.assign(p.product, { commands: [commandRecord()] });
    retain();
    expect(await api.readCurrentWork(scope)).toMatchObject({ activity: { current: [
      { kind: "command", state: "inactive", status: "Last observed: Running" },
    ] } });
  });
  it("retains a bounded recent result set and keeps command settlement separate from Tool return", async () => {
    const { p, api } = fixture();
    const call = callRecord("shell", "root", "PowerShell", { command: "dotnet build" }, "invocation");
    Object.assign(call.content, { settlement: "succeeded" });
    Object.assign(p.product.presentation, { records: [call], activeCalls: [] });
    Object.assign(p.product, { commands: [commandRecord()] });
    expect(await api.readCurrentWork(scope)).toMatchObject({ activity: { current: [
      { kind: "command", status: "Running" },
    ], recent: [] } });
    Object.assign(p.product, { commands: Array.from({ length: 6 }, (_, n) => ({ ...commandRecord(),
      executionId: `exec-${n}`, phase: "settled", exitCode: n, completedAt: `2026-09-22T00:00:0${n}Z`,
    })) });
    const page = await api.readCurrentWork(scope);
    if (page.status !== "page") throw Error("Expected page");
    expect(page.activity.recent).toHaveLength(3);
    expect(page.activity.recent[0]).toMatchObject({ status: "Exited with code 5", state: "settled" });
    expect(page.activity.omittedRecent).toBe(3);
  });
  it("bounds activity independently of current-work collection paging", async () => {
    const { p, api } = fixture();
    Object.assign(p.product.presentation, { activeCalls: Array.from({ length: 60 }, (_, n) =>
      callRecord(`read-${n}`, "root", "Read", { file_path: `file-${n}.txt` })) });
    const page = await api.readCurrentWork(scope);
    if (page.status !== "page") throw Error("Expected page");
    expect(page.activity.current).toHaveLength(24);
    expect(page.activity.omittedCurrent).toBe(36);
    expect(page.activeCalls).toHaveLength(60);
  });
  it("uses the recorded main objective as its bounded title in both work and detail reads", async () => {
    const { p, api } = fixture();
    const label = p.product.presentation.labels[0]!;
    const objective = "Inspect the workspace. ".repeat(20);
    Object.assign(label, { objective });
    expect(await api.readCurrentWork(scope)).toMatchObject({ tasks: [
      { runId: "root", parentRunId: null, label: objective.trim().slice(0, 160), objective },
      { runId: "child", parentRunId: "root", label: "Delegated work" },
    ] });
    expect(await api.readTaskDetails(scope)).toMatchObject({ task: {
      runId: "root", label: objective.trim().slice(0, 160), objective,
    } });
    expect(label.label).toBe("Root");
    Object.assign(label, { objective: null });
    expect(await api.readTaskDetails(scope)).toMatchObject({ task: { label: "Main task" } });
  });
  it("identifies retained finished work independently of the task lifecycle", async () => {
    const { p, api } = fixture();
    Object.assign(p.product.presentation, { records: [{ ...textRecord(1, "child"), content: {
      kind: "tool_call", callableKind: "tool", name: "Read", resolvedName: "Read", settlement: "failed", input: {}, result: null,
    } }] });
    expect(await api.readCurrentWork(scope)).toMatchObject({ tasks: [
      { runId: "root", status: "running", hasFinishedWork: false },
      { runId: "child", status: "running", hasFinishedWork: true },
    ] });
    Object.assign(p.product.presentation, { records: [] });
    Object.assign(p.product, { commands: [{ runId: "child", phase: "settled", outcome: "cancelled" }] });
    expect(await api.readTaskDetails({ ...scope, runId: "child" })).toMatchObject({ task: {
      status: "running", hasFinishedWork: true,
    } });
  });
  it("keeps internal instructions and diagnostics out of task reads without changing recorded facts", async () => {
    const { p, api } = fixture();
    const label = { runId: "child", parentRunId: "root", parentRunActionId: "action",
      label: "Inspect dependencies", objective: "Internal delegation prompt." };
    Object.assign(p.product.presentation, { labels: [...p.product.presentation.labels, label] });
    Object.assign(p.host, { retry: { diagnostic: "retry-detail" } });
    Object.assign(p.product, { qualification: { diagnostic: "qualification-detail" } });
    const child = await api.readTaskDetails({ ...scope, runId: "child" });
    const root = await api.readTaskDetails(scope);
    expect(child).toMatchObject({ task: { label: "Inspect dependencies", objective: null }, problem: null });
    for (const page of [child, root]) {
      expect(page).not.toHaveProperty("diagnostics");
      expect(page).not.toHaveProperty("retries");
      expect(JSON.stringify(page)).not.toContain("Internal delegation prompt");
    }
    expect(await api.readCurrentWork(scope)).toMatchObject({ tasks: [
      expect.anything(), expect.objectContaining({ objective: null }),
    ] });
    expect(label.objective).toBe("Internal delegation prompt.");
    expect(p.host.retry).toEqual({ diagnostic: "retry-detail" });
    const response = textRecord(1, "child", "Recorded subtask findings.");
    Object.assign(p.product.presentation, { records: [response] });
    expect(await api.readWorkbenchItem({ ...scope, runId: "child", itemId: response.id })).toMatchObject({
      title: "Subtask response", text: "Recorded subtask findings.",
    });
  });
  it("retains scoped failure explanations without borrowing a sibling's error or diagnosing completed work", async () => {
    const { p, api } = fixture();
    const child = p.host.runTree.nodes[1]!;
    Object.assign(child, { status: "failed", terminal: { code: "provider_timeout" } });
    Object.assign(p.product.presentation, { records: [
      { ...textRecord(1), content: { kind: "tool_call", result: {
        kind: "descendant_run", childRunId: "child", failure: { code: "provider_timeout", message: "The model request timed out." },
      } } },
      { ...textRecord(2), content: { kind: "tool_call", result: {
        kind: "descendant_run", childRunId: "sibling", failure: { code: "provider_timeout", message: "Sibling failure." },
      } } },
    ] });
    expect(await api.readTaskDetails({ ...scope, runId: "child" })).toMatchObject({
      problem: { message: "The model request timed out.", code: "provider_timeout" },
    });
    Object.assign(child, { terminal: { code: "runtime_execution_failed" } });
    expect(await api.readTaskDetails({ ...scope, runId: "child" })).toMatchObject({
      problem: { message: expect.stringContaining("A detailed explanation is not available"), code: "runtime_execution_failed" },
    });
    Object.assign(child, { status: "completed", terminal: { code: "completion_accepted" } });
    expect(await api.readTaskDetails({ ...scope, runId: "child" })).toMatchObject({ problem: null });
  });
  it("presents bound delegated work, its reply and its exact child without runtime envelopes", async () => {
    const { p, api } = fixture();
    const record = {
      ...textRecord(1), content: {
        kind: "tool_call", callableKind: "tool", name: "Agent_6e06f4afa928", resolvedName: "Agent",
        callId: "call-id", turnId: "turn-id", runActionId: "action", invocationId: null,
        input: { description: "Inspect dependencies", prompt: "Review the declared dependencies. Do not edit." },
        settlement: "succeeded", result: { kind: "descendant_run", childRunId: "child", status: "succeeded",
          failure: null, output: { agent_id: "secret-continuation", status: "completed", summary: "## Findings\nNo edits made.",
            effect_status: "none", uncertainty: ["cost_units_unavailable"], artifact_refs: [] } },
      },
    };
    Object.assign(p.product.presentation, { records: [record], activeCalls: [record],
      labels: [{ runId: "child", parentRunId: "root", parentRunActionId: "action", label: "Inspect dependencies", objective: "Inspect" }] });
    const current = await api.readCurrentWork(scope);
    expect(current).toMatchObject({ activeCalls: [{ content: { title: "Delegated task: Inspect dependencies" } }] });
    const result = await api.readWorkbenchItem({ ...scope, itemId: record.id });
    expect(result).toMatchObject({ status: "operation", detail: { title: "Delegated task", status: "Returned",
      child: { runId: "child", label: "Inspect dependencies", status: "running" },
      sections: [{ label: "Subtask findings", text: "## Findings\nNo edits made.", format: "markdown" } ] } });
    for (const internal of ["Agent_6e06f4afa928", "call-id", "turn-id", "secret-continuation", "descendant_run", "run_item", record.content.input.prompt])
      expect(JSON.stringify(result)).not.toContain(internal);
    expect(await api.readWorkbenchItem({ ...scope, itemId: record.id, section: "request" })).toMatchObject({ code: "invalid_query" });
    expect(await api.readWorkbenchItem({ ...scope, runId: "child", itemId: record.id })).toMatchObject({ code: "not_found" });
    Object.assign(record.content.result, { status: "failed", failure: { code: "provider_timeout", message: "The model request timed out." } });
    Object.assign(record.content, { settlement: "failed" });
    const failed = await api.readWorkbenchItem({ ...scope, itemId: record.id });
    expect(failed).toMatchObject({ detail: { status: "Failed", sections: expect.arrayContaining([
      expect.objectContaining({ label: "Subtask findings" }), expect.objectContaining({ label: "Problem", text: "The model request timed out." }),
    ]) } });
    Object.assign(record.content, { resolvedName: "SendMessage", input: { prompt: "Internal coordination instructions." } });
    const message = await api.readWorkbenchItem({ ...scope, itemId: record.id });
    expect(JSON.stringify(message)).not.toContain("Internal coordination instructions");
    expect(message).toMatchObject({ detail: { summary: null } });
  });
  it("reads active retained summaries and pages full operation content without replay or raw fallback", async () => {
    const { p, api } = fixture();
    const content = '\"\\\n'.repeat(20000);
    const record = { ...textRecord(1), content: { kind: "tool_call", callableKind: "tool", name: "Write_hash", resolvedName: "Write",
      callId: "call", turnId: "turn", input: { file_path: "result.json", content },
      runActionId: "action", invocationId: null, settlement: null, result: null } };
    Object.assign(p.product.presentation, { activeCalls: [record] });
    const query = { ...scope, itemId: record.id };
    const first = await api.readWorkbenchItem(query);
    expect(first.status).toBe("operation");
    if (first.status !== "operation") return;
    let part = first.detail.sections.find(s => s.id === "content")!;
    let text = part.text;
    while (part.nextOffset !== null) {
      const next = await api.readWorkbenchItem({ ...query, section: "content", offset: part.nextOffset });
      expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(256 * 1024);
      if (next.status !== "operation") throw new Error("Expected content page");
      part = next.detail.sections[0]!;
      text += part.text;
    }
    expect(text).toBe(content);
    expect(await api.readWorkbenchItem({ ...query, section: "missing" })).toMatchObject({ code: "invalid_query" });
    expect(await api.readWorkbenchItem({ ...query, section: "content", offset: content.length + 1 })).toMatchObject({ code: "invalid_query" });
    Object.assign(record.content, { callableKind: "unresolved", resolvedName: null, name: "Agent_not_bound" });
    expect(await api.readWorkbenchItem(query)).toMatchObject({ detail: { title: "Model call" } });
  });
  it("keeps real structured Tool output but not the operation wrapper or credentials", async () => {
    const { p, api } = fixture();
    const record = { ...textRecord(1), content: { kind: "tool_call", callableKind: "tool", name: "Read_hash", resolvedName: "Read",
      callId: "call", turnId: "turn", input: { file_path: "info.json" }, runActionId: null, invocationId: null,
      settlement: "succeeded", result: { kind: "operation", status: "succeeded", failure: null,
        output: { content: "hello", count: 1, credentials: "do-not-display" } } } };
    Object.assign(p.product.presentation, { records: [record] });
    const result = await api.readWorkbenchItem({ ...scope, itemId: record.id });
    expect(result).toMatchObject({ status: "operation", detail: { sections: expect.arrayContaining([
      expect.objectContaining({ label: "Output", format: "json", text: '{\n  "content": "hello",\n  "count": 1\n}' }),
    ]) } });
    expect(JSON.stringify(result)).not.toContain("do-not-display");
  });
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
            callableKind: "tool", resolvedName: "Read",
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
        callableKind: "tool", resolvedName: "Read",
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

function callRecord(id: string, runId: string, name: string, input: Record<string, string>, invocationId: string | null = null) {
  return { ...textRecord(1, runId), id, content: { kind: "tool_call" as const,
    callableKind: "tool" as const, toolBindingKind: "operation" as const, interactionProtocol: null,
    callId: id, turnId: "turn", name: `${name}_hash`, resolvedName: name, input,
    runActionId: null as string | null, invocationId, settlement: null as string | null, result: null } };
}
function commandRecord() {
  return { runId: "root", executionId: "execution", revision: 1, phase: "running", processId: 123,
    outcome: null, capturedBytes: 0, omittedBytes: 0, outputPersistence: "live", observedAt: "2026-09-22T00:00:00Z",
    command: "dotnet build", shell: "powershell", cwd: "D:/example", startedAt: "2026-09-22T00:00:00Z",
    completedAt: null, exitCode: null, invocationId: "invocation" };
}
