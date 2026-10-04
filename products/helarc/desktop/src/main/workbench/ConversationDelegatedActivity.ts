import { helarcSubtaskName, type HelarcRunProjection } from "@agent-anything/helarc/run";
import type { ConversationActivityRow, ConversationDelegatedActivity } from "../../shared/HelarcWorkbench.js";
import { modelResponseProgress } from "../../shared/ModelResponsePresentation.js";
import { commandActivity } from "./ConversationCommandPresentation.js";
import { isWorkbenchOperation, workbenchOperationTitle } from "./WorkbenchOperationPresentation.js";

const ended = (status: string) => ["completed", "failed", "cancelled"].includes(status);
const key = (runId: string, id: string) => JSON.stringify([runId, id]);

export function conversationDelegatedActivity(
  projection: HelarcRunProjection, childRunId: string, live: boolean,
): ConversationDelegatedActivity {
  const { host, product } = projection;
  const empty: ConversationDelegatedActivity = {items: [], activeCount: 0, omittedCount: 0, retentionLimited: false};
  if (!live || ended(host.status)) return empty;
  const nodes = new Map(host.runTree.nodes.map(node => [node.runId, node]));
  if (!nodes.has(childRunId)) return empty;
  const children = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.parentRunId !== null) children.set(node.parentRunId, [...(children.get(node.parentRunId) ?? []), node.runId]);
  }
  const subtree = new Set<string>();
  const queue = [childRunId];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    if (subtree.has(id)) continue;
    subtree.add(id);
    queue.push(...(children.get(id) ?? []));
  }
  const items: ConversationActivityRow[] = [];
  const name = (runId: string) => helarcSubtaskName(product.presentation.labels, runId);
  const commands = product.commands.filter(command => subtree.has(command.runId));
  const commandOrigins = new Set(commands.flatMap(command => command.origin ? [key(command.runId, command.origin.modelItemId)] : []));
  const commandInvocations = new Set(commands.flatMap(command => command.invocationId ? [key(command.runId, command.invocationId)] : []));
  for (const command of commands) {
    if (command.outcome !== null || command.phase === "settled") continue;
    const { detail: _detail, child: _child, ...row } = commandActivity(command, true);
    items.push({...row, id: key(command.runId, row.id), attribution: name(command.runId)});
  }
  const records = new Map([...product.presentation.records, ...product.presentation.activeCalls]
    .map(record => [key(record.runId, record.id), record]));
  for (const record of records.values()) {
    if (!subtree.has(record.runId) || ended(nodes.get(record.runId)!.status) || !isWorkbenchOperation(record)) continue;
    const call = record.content;
    if (call.kind !== "tool_call" || call.settlement !== null) continue;
    if (record.origin && commandOrigins.has(key(record.runId, record.origin.modelItemId))) continue;
    if ([call.invocationId, ...call.invocationIds].some(id => id && commandInvocations.has(key(record.runId, id)))) continue;
    // The actual Child activity replaces its still-pending delegation wrapper.
    if (host.runTree.nodes.some(node => node.parentRunId === record.runId && call.runActionId && node.parentRunActionId === call.runActionId)) continue;
    items.push({
      id: key(record.runId, record.id), runId: record.runId, kind: "operation",
      title: workbenchOperationTitle(call), attribution: name(record.runId), state: "ongoing",
      status: "Result pending", startedAt: null, endedAt: null, observedAt: record.observedAt,
    });
  }
  const latest = new Map(product.responses.attempts.map(attempt => [attempt.runId, attempt]));
  for (const [runId, attempt] of latest) {
    if (!subtree.has(runId) || ended(nodes.get(runId)!.status)) continue;
    const title = modelResponseProgress(attempt);
    if (title) items.push({
      id: key(runId, attempt.invocationId), runId, kind: "model", title, attribution: name(runId),
      state: "ongoing", status: "", startedAt: null, endedAt: null, observedAt: attempt.observedAt,
    });
  }
  items.sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id));
  return {
    items: items.slice(0, 8), activeCount: items.length, omittedCount: Math.max(0, items.length - 8),
    retentionLimited: product.presentation.omittedActiveCalls > 0 || product.responses.omittedAttempts > 0,
  };
}
