import { describe, expect, it } from "vitest";
import type { HelarcRunLabel, HelarcRunProjection, HelarcRunPresentationRecord, HelarcResponsePreview } from "@agent-anything/helarc/run";
import { conversationDelegatedActivity } from "./ConversationDelegatedActivity.js";

const at = "2026-09-30T00:00:00.000Z";
function label(runId: string, parentRunId: string | null, siblingOrdinal: number | null): HelarcRunLabel {
  return {runId, parentRunId, siblingOrdinal, parentRunActionId: `create-${runId}`, parentOrigin: null, label: "Inspect", objective: "Private prompt"};
}
function call(id: string, runId = "child"): HelarcRunPresentationRecord {
  return {id, runId, sequence: 1, revision: 1, observedAt: at,
    source: {owner: "runtime", kind: "run_item", id: "source", sequence: 1},
    origin: {runId, turnId: "turn", turnSequence: 1, modelItemId: id, ordinal: 0, callId: id, source: {id: "source", sequence: 1}},
    content: {kind: "tool_call", callId: id, turnId: "turn", name: "Read_hash", resolvedName: "Read", callableKind: "tool",
      toolBindingKind: "operation", interactionProtocol: null, input: {file_path: "file.txt"}, runActionId: `action-${id}`,
      invocationId: `invocation-${id}`, invocationIds: [`invocation-${id}`], settlement: null, result: null}};
}
function attempt(id: string, state: HelarcResponsePreview["state"] = "receiving", runId = "child"): HelarcResponsePreview {
  return {runId, requestId: id, controllerRequestId: id, invocationId: id, revision: 100, observedAt: at,
    deliverySequence: 1, mode: "streaming", state, code: null, parts: []};
}
function fixture() {
  return {
    host: {runId: "root", status: "running", runTree: {nodes: [
      {runId: "root", parentRunId: null, status: "running"},
      {runId: "child", parentRunId: "root", parentRunActionId: "create-child", status: "running"},
      {runId: "nested", parentRunId: "child", parentRunActionId: "action-delegate", status: "running"},
      {runId: "other", parentRunId: "root", status: "running"},
    ]}},
    product: {commands: [], responses: {attempts: [], omittedAttempts: 0}, presentation: {
      records: [], activeCalls: [], omittedActiveCalls: 0,
      labels: [label("root", null, null), label("child", "root", 1), label("nested", "child", 1), label("other", "root", 2)],
    }},
  } as unknown as HelarcRunProjection;
}
function command(id = "shell", runId = "nested") {
  return {runId, executionId: `execution-${id}`, revision: 1, phase: "running", processId: 10,
    origin: call(id, runId).origin, outcome: null, capturedBytes: 0, omittedBytes: 0, outputPersistence: "live",
    observedAt: "2026-09-30T00:00:02.000Z", command: "dotnet build", startedAt: at, invocationId: `invocation-${id}`};
}
describe("delegated conversation activity", () => {
  it("attributes nested work and deduplicates actual commands, not similar text", () => {
    const p = fixture();
    const shell = call("shell", "nested"), delegate = call("delegate"), read = call("read");
    Object.assign(p.product.presentation, {records: [shell, delegate, read, call("other", "other")], activeCalls: [read]});
    Object.assign(p.product, {commands: [command(), {...command("same-text"), origin: null, invocationId: null}]});
    const result = conversationDelegatedActivity(p, "child", true);
    expect(result.activeCount).toBe(3);
    expect(result.items.map(item => [item.kind, item.attribution])).toEqual([
      ["command", "Subtask 1.1"], ["command", "Subtask 1.1"], ["operation", "Subtask 1"],
    ]);
    expect(JSON.stringify(result)).not.toContain("Read_hash");
    expect(JSON.stringify(result)).not.toContain("Private prompt");
    expect(result.items.every(item => item.runId !== "other")).toBe(true);
  });
  it("keeps commands after their Tool settles, including exact invocation joins without an origin", () => {
    const p = fixture(), shell = call("shell");
    Object.assign(p.product.presentation, {records: [shell]});
    Object.assign(p.product, {commands: [{...command("shell", "child"), origin: null}]});
    expect(conversationDelegatedActivity(p, "child", true).items.map(item => item.kind)).toEqual(["command"]);
    if (shell.content.kind === "tool_call") Object.assign(shell.content, {settlement: "succeeded"});
    expect(conversationDelegatedActivity(p, "child", true).activeCount).toBe(1);
    Object.assign(p.product.commands[0]!, {phase: "settled"});
    expect(conversationDelegatedActivity(p, "child", true).activeCount).toBe(0);
  });
  it("replaces completed work with the latest actual model attempt, not stale requests or Run status", () => {
    const p = fixture(), read = call("read"), response = attempt("latest");
    Object.assign(p.product.presentation, {records: [read]});
    expect(conversationDelegatedActivity(p, "child", true).items[0]?.kind).toBe("operation");
    Object.assign(read.content, {settlement: "succeeded"});
    Object.assign(p.product.responses, {attempts: [attempt("old"), response]});
    expect(conversationDelegatedActivity(p, "child", true).items.map(item => item.title)).toEqual(["Waiting for model response"]);
    Object.assign(response, {parts: [{receivedLength: 1}]});
    expect(conversationDelegatedActivity(p, "child", true).items[0]?.title).toBe("Receiving model response");
    Object.assign(response, {state: "received"});
    expect(conversationDelegatedActivity(p, "child", true).items[0]?.title).toBe("Processing model response");
    Object.assign(response, {state: "committed"});
    expect(conversationDelegatedActivity(p, "child", true).items).toEqual([]);
  });
  it("excludes controls and questions by semantics and does not guess from callable names", () => {
    const p = fixture();
    const control = call("plan"), question = call("question"), misleadingName = call("read");
    Object.assign(control.content, {callableKind: "control", resolvedName: "update_plan"});
    Object.assign(question.content, {toolBindingKind: "interaction"});
    Object.assign(misleadingName.content, {name: "update_plan", resolvedName: "Read"});
    Object.assign(p.product.presentation, {records: [control, question, misleadingName]});
    expect(conversationDelegatedActivity(p, "child", true).items).toHaveLength(1);
  });
  it("suppresses historical and terminated work without hiding live process settlement", () => {
    const p = fixture();
    Object.assign(p.product.presentation, {activeCalls: [call("read")]});
    Object.assign(p.product.responses, {attempts: [attempt("request")]});
    Object.assign(p.host.runTree.nodes[1]!, {status: "completed"});
    expect(conversationDelegatedActivity(p, "child", true).items).toEqual([]);
    Object.assign(p.product, {commands: [command("background", "child")]});
    expect(conversationDelegatedActivity(p, "child", true).items[0]?.kind).toBe("command");
    expect(conversationDelegatedActivity(p, "child", false).items).toEqual([]);
    Object.assign(p.host, {status: "completed"});
    expect(conversationDelegatedActivity(p, "child", true).items).toEqual([]);
  });
  it("bounds current rows and discloses loss without sorting by unrelated revision counters", () => {
    const p = fixture();
    Object.assign(p.product.presentation, {activeCalls: Array.from({length: 12}, (_, i) => call(`read-${i}`)), omittedActiveCalls: 2});
    Object.assign(p.product, {commands: [command()]});
    Object.assign(p.product.responses, {attempts: [attempt("request")]});
    const result = conversationDelegatedActivity(p, "child", true);
    expect(result).toMatchObject({activeCount: 14, omittedCount: 6, retentionLimited: true});
    expect(result.items).toHaveLength(8);
    expect(result.items[0]?.kind).toBe("command");
  });
});
