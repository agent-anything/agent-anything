import type { HelarcRunProjection, HelarcCommandProgress } from "@agent-anything/helarc/run";
import type { WorkbenchActivity, WorkbenchActivityItem } from "../../shared/HelarcWorkbench.js";
import { isWorkbenchOperation, workbenchOperationTitle } from "./WorkbenchOperationPresentation.js";
import { isWorkbenchInteraction } from "./WorkbenchInteractionPresentation.js";

const ended = (status: string) => ["completed", "failed", "cancelled"].includes(status);
const short = (value: string, limit = 180) => {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit)}...` : line;
};
const settlements: Readonly<Record<string, string>> = {
  succeeded: "Returned", partial: "Partially returned", failed: "Failed",
  cancelled: "Cancelled", invalid: "Not executed", invalidated: "Invalidated",
  denied: "Not approved", timed_out: "Timed out", unknown_effect: "Outcome uncertain",
};

/** Desktop-only, bounded reading projection. Never infers an execution from a requested call. */
export function workbenchActivity(p: HelarcRunProjection, live: boolean): WorkbenchActivity {
  const current: WorkbenchActivityItem[] = [], recent: WorkbenchActivityItem[] = [];
  const observed = new Map<string, string>();
  const nodes = p.host.runTree.nodes;
  const canAdvance = (runId: string) => live && !ended(p.host.status) &&
    nodes.some(n => n.runId === runId && !ended(n.status));
  const label = (id: string) => id === p.host.runId ? null
    : short(p.product.presentation.labels.find(l => l.runId === id)?.label ?? "Subtask", 100);
  const commandKeys = new Set(p.product.commands.filter(c => c.invocationId)
    .map(c => JSON.stringify([c.runId, c.invocationId])));

  for (const c of p.product.commands) {
    const settled = c.phase === "settled";
    const active = live && !ended(p.host.status);
    const item: WorkbenchActivityItem = {
      id: `command:${c.runId}:${c.executionId}`, runId: c.runId, kind: "command",
      title: short(c.command ?? "Shell command"), attribution: label(c.runId),
      state: settled ? "settled" : active ? "ongoing" : "inactive",
      status: settled ? commandResult(c) : active ? commandPhase(c.phase) : `Last observed: ${commandPhase(c.phase)}`,
      startedAt: c.startedAt ?? null, endedAt: c.completedAt ?? null,
      detail: { kind: "command", executionId: c.executionId },
    };
    if (settled) { recent.push(item); observed.set(item.id, c.completedAt ?? c.observedAt); }
    else current.push(item);
  }

  const calls = new Map([...p.product.presentation.records, ...p.product.presentation.activeCalls]
    .filter(isWorkbenchOperation).map(r => [JSON.stringify([r.runId, r.id]), r]));
  for (const r of calls.values()) {
    const c = r.content;
    if (c.kind !== "tool_call") continue;
    if (c.invocationId && commandKeys.has(JSON.stringify([r.runId, c.invocationId]))) continue;
    const child = c.resolvedName === "Agent" && c.runActionId
      ? nodes.find(n => n.parentRunId === r.runId && n.parentRunActionId === c.runActionId) : null;
    if (c.settlement === null && child && !ended(child.status)) continue;
    const settled = c.settlement !== null;
    const item: WorkbenchActivityItem = {
      id: `call:${r.runId}:${r.id}`, runId: r.runId, kind: "operation",
      title: workbenchOperationTitle(c), attribution: label(r.runId),
      state: settled ? "settled" : canAdvance(r.runId) ? "ongoing" : "inactive",
      status: settled ? settlements[c.settlement!] ?? "Returned"
        : canAdvance(r.runId) ? "Result pending" : "No recorded result",
      startedAt: null, endedAt: null,
      detail: { kind: "operation", itemId: r.id },
    };
    if (settled) { recent.push(item); observed.set(item.id, r.observedAt); }
    else current.push(item);
  }

  for (const i of live && !ended(p.host.status) ? p.host.pendingInteractions : []) {
    const representedByForm = p.product.presentation.activeCalls.some(record => {
      if (record.runId !== i.runId || !isWorkbenchInteraction(record)) return false;
      const protocol = record.content.interactionProtocol;
      return protocol && protocol.owner === i.request.protocol?.owner &&
        protocol.kind === i.request.protocol.kind && protocol.revision === i.request.protocol.revision;
    });
    if (representedByForm) continue;
    current.push({ id: `attention:${i.runId}:${i.request.id}`, runId: i.runId, kind: "attention",
      title: "Your input is needed", attribution: label(i.runId), state: "waiting",
      status: i.phase === "submitted_for_resolution" ? "Answer submitted" : "Review the request below",
      startedAt: null, endedAt: null, detail: null });
  }
  const responseRuns = new Set<string>();
  for (const a of [...p.product.responses.attempts].reverse()) {
    if (!canAdvance(a.runId) || responseRuns.has(a.runId) || !["receiving", "received", "validated"].includes(a.state)) continue;
    responseRuns.add(a.runId);
    const receiving = a.state === "receiving";
    current.push({ id: `response:${a.runId}`, runId: a.runId, kind: "response",
      title: receiving ? a.parts.some(part => part.receivedLength > 0) ? "Receiving model response" : "Waiting for model response"
        : "Processing model response", attribution: label(a.runId), state: "ongoing",
      status: "", startedAt: null, endedAt: null, detail: null });
  }
  if (live && p.host.status === "waiting" && p.host.retry) {
    const last = p.host.retry.recentEvents.at(-1);
    if (last?.event === "retry_scheduled") {
      current.push({ id: `retry:${p.host.runId}`, runId: p.host.runId, kind: "response",
        title: ["provider_request", "response_stream"].includes(last.owner) ? "Waiting to retry model request" : "Waiting to retry",
        attribution: null, state: "waiting", status: last.attemptNumber === null ? "" : `Attempt ${last.attemptNumber}`,
        startedAt: null, endedAt: null, detail: null });
    }
  }
  // Call observation time is not a finish time. Recency selection cannot establish execution order.
  recent.sort((a, b) => (observed.get(b.id) ?? "").localeCompare(observed.get(a.id) ?? ""));
  const boundedCurrent = bound(current, 24, 20 * 1024);
  const boundedRecent = bound(recent, 3, 4 * 1024);
  return { current: boundedCurrent, recent: boundedRecent,
    omittedCurrent: current.length - boundedCurrent.length + p.product.presentation.omittedActiveCalls,
    omittedRecent: recent.length - boundedRecent.length };
}

function bound(items: WorkbenchActivityItem[], maximum: number, bytes: number) {
  const result: WorkbenchActivityItem[] = [];
  for (const item of items) {
    if (result.length === maximum || Buffer.byteLength(JSON.stringify([...result, item])) > bytes) break;
    result.push(item);
  }
  return result;
}
function commandPhase(phase: string): string {
  return ({ starting: "Starting", running: "Running", draining: "Finishing output capture",
    stopping: "Stopping", terminating: "Stopping", unresolved: "Process state unresolved" } as Record<string, string>)[phase]
    ?? "Execution pending";
}
function commandResult(c: HelarcCommandProgress): string {
  if (c.exitCode !== null && c.exitCode !== undefined) return `Exited with code ${c.exitCode}`;
  return c.outcome ? `Ended: ${c.outcome.replaceAll("_", " ")}` : "Ended; exit status unavailable";
}
