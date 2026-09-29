import type {
  HelarcModelItemOrigin,
  HelarcRunProjection,
  HelarcRunPresentationRecord,
  HelarcCommandProgress,
} from "@agent-anything/helarc/run";
import type { HelarcThreadRecord } from "@agent-anything/helarc/work-context";
import type * as D from "../../shared/HelarcWorkbench.js";
import {
  isWorkbenchOperation,
  workbenchOperationTitle,
} from "./WorkbenchOperationPresentation.js";
import { workbenchInteractionText } from "./WorkbenchInteractionPresentation.js";
import { textPage } from "./WorkbenchReadLimits.js";

const ended = (status: string) =>
  ["completed", "failed", "cancelled"].includes(status);
const short = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200);
const settlements: Record<string, string> = {
  succeeded: "Returned",
  partial: "Partially returned",
  failed: "Failed",
  cancelled: "Cancelled",
  invalid: "Not executed",
  invalidated: "Invalidated",
  denied: "Not approved",
  timed_out: "Timed out",
  unknown_effect: "Outcome uncertain",
};
export const outputModelItems = (
  source: D.HelarcOutputSource | undefined,
): readonly string[] =>
  source?.kind === "model_text"
    ? source.modelItemIds
    : source?.kind === "model_control"
      ? [source.modelItemId]
      : [];

export interface ConversationTurn {
  entry: D.ConversationTurnEntry;
  blocks: D.ConversationBlock[];
}
export function presentConversationWork(
  thread: HelarcThreadRecord,
  productRunId: string,
  anchor: number,
  p: HelarcRunProjection,
  live: boolean,
  runId: string,
) {
  const scope: D.WorkbenchScope = {
    threadId: thread.thread.id,
    productRunId,
    runId,
  };
  const turns = new Map<string, ConversationTurn>();
  const notices: D.ConversationMessageEntry[] = [];
  const placedMessages = new Set<string>();
  const records = new Map(
    [...p.product.presentation.records, ...p.product.presentation.activeCalls]
      .filter((r) => r.runId === runId)
      .map((r) => [r.id, r]),
  );
  const commands = p.product.commands.filter((c) => c.runId === runId);
  const labels = p.product.presentation.labels.filter(
    (l) => l.parentRunId === runId,
  );
  const sourceRecords = [...records.values()];
  const origins = new Map<string, HelarcModelItemOrigin>();
  for (const r of sourceRecords)
    if (r.origin) origins.set(r.origin.modelItemId, r.origin);
  for (const c of commands)
    if (c.origin) origins.set(c.origin.modelItemId, c.origin);
  for (const l of labels)
    if (l.parentOrigin) origins.set(l.parentOrigin.modelItemId, l.parentOrigin);
  const recordFor = (id: string) =>
    sourceRecords.find((r) => r.origin?.modelItemId === id);
  const detail = (itemId: string): D.WorkbenchItemQuery => ({
    ...scope,
    itemId,
  });
  const turnFor = (o: HelarcModelItemOrigin) => {
    let turn = turns.get(o.turnId);
    if (!turn) {
      turn = {
        entry: {
          kind: "turn",
          id: `turn:${productRunId}:${runId}:${o.turnId}`,
          title: null,
          role: "assistant",
          position: [anchor, o.turnSequence],
          revision: p.product.sequence + p.host.sequence,
          content: "",
          omittedBytes: 0,
          productRunId,
          runId,
          sourceId: o.turnId,
          modelItemIds: [],
          detail: null,
          artifactIds: [],
          disposition: null,
          scope,
          turnId: o.turnId,
          blocks: [],
          nextCursor: null,
          blockCount: 0,
          partial: false,
        },
        blocks: [],
      };
      turns.set(o.turnId, turn);
    }
    return turn;
  };
  const active = live && !ended(p.host.status);
  for (const o of origins.values()) {
    const r = recordFor(o.modelItemId);
    const c = r?.content;
    const work = commands.filter(
      (command) => command.origin?.modelItemId === o.modelItemId,
    );
    const created = labels.find(
      (label) => label.parentOrigin?.modelItemId === o.modelItemId,
    );
    if (c?.kind === "assistant_text" || c?.kind === "final_response") {
      const message =
        runId === p.host.runId
          ? thread.messages.find(
              (m) =>
                m.correlation.runId === productRunId &&
                m.source.kind === "agent_run" &&
                outputModelItems(
                  m.metadata.outputSource as D.HelarcOutputSource | undefined,
                ).includes(o.modelItemId),
            )
          : undefined;
      const text = textPage(message?.content ?? c.text, 0, 2048);
      turnFor(o).blocks.push({
        id: o.modelItemId,
        modelItemId: o.modelItemId,
        ordinal: o.ordinal,
        kind: c.kind === "final_response" ? "final_response" : "text",
        text: text.text,
        omittedBytes: text.omittedBytes + (message ? 0 : c.omittedBytes),
        detail: detail(message ? `message:${message.id}` : r!.id),
        disposition:
          c.kind !== "final_response" ||
          message ||
          c.disposition === "completed"
            ? null
            : ["proposed", "accepted"].includes(c.disposition)
              ? "Awaiting completion"
              : "Not finalized",
        artifactIds: message?.relatedArtifactIds ?? [],
      });
      if (message) placedMessages.add(message.id);
      continue;
    }
    if (r && !isWorkbenchOperation(r)) continue;
    if (!r && !work.length && !created) continue;
    const turn = turnFor(o);
    if (!r) turn.entry = { ...turn.entry, partial: true };
    const call = c?.kind === "tool_call" ? c : null;
    const result = call?.result;
    const referencedId =
      result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      "kind" in result &&
      [
        "descendant_run",
        "descendant_progress",
        "descendant_result_transfer",
      ].includes(String(result.kind)) &&
      "childRunId" in result &&
      typeof result.childRunId === "string"
        ? result.childRunId
        : null;
    const node = p.host.runTree.nodes.find(
      (n) =>
        n.parentRunId === runId && n.runId === (created?.runId ?? referencedId),
    );
    const child: D.ConversationActivityItem["child"] = node
      ? {
          scope: { ...scope, runId: node.runId },
          label: short(
            created?.label ??
              p.product.presentation.labels.find((l) => l.runId === node.runId)
                ?.label ??
              "Delegated task",
          ),
          status: !live && !ended(node.status) ? "inactive" : node.status,
          relationship: created ? "created" : "referenced",
        }
      : null;
    const base: D.ConversationActivityItem = {
      id: `call:${runId}:${o.modelItemId}`,
      runId,
      kind: "operation",
      title: call
        ? workbenchOperationTitle(call)
        : (child?.label ?? "Operation details no longer retained"),
      attribution: null,
      state: call?.settlement ? "settled" : active ? "ongoing" : "inactive",
      status: call?.settlement
        ? (settlements[call.settlement] ?? "Returned")
        : active
          ? "Result pending"
          : "No recorded result",
      startedAt: null,
      endedAt: null,
      detail: r ? { kind: "operation", itemId: r.id } : null,
      child,
    };
    if (work.length)
      work.forEach((command, index) => {
        const id = index === 0 ? base.id : `${base.id}:${command.executionId}`;
        turn.blocks.push({
          kind: "activity",
          id,
          modelItemId: o.modelItemId,
          ordinal: o.ordinal,
          item: { ...commandActivity(command, active), id, child: null },
        });
      });
    else
      turn.blocks.push({
        kind: "activity",
        id: base.id,
        modelItemId: o.modelItemId,
        ordinal: o.ordinal,
        item: base,
      });
  }
  // Only exact final-source identity can replace candidate text with a durable Message.
  if (runId === p.host.runId)
    for (const m of thread.messages) {
      if (
        placedMessages.has(m.id) ||
        m.correlation.runId !== productRunId ||
        m.source.kind !== "agent_run"
      )
        continue;
      const source = m.metadata.outputSource as
        | D.HelarcOutputSource
        | undefined;
      if (source?.kind !== "model_control") continue;
      const turn = turns.get(source.turnId);
      if (!turn) continue;
      const text = textPage(m.content, 0, 2048);
      turn.blocks.push({
        kind: "final_response",
        id: source.modelItemId,
        modelItemId: source.modelItemId,
        ordinal: source.modelCallRef.contentBlockOrdinal,
        text: text.text,
        omittedBytes: text.omittedBytes,
        detail: detail(`message:${m.id}`),
        disposition: null,
        artifactIds: m.relatedArtifactIds,
      });
      placedMessages.add(m.id);
    }
  for (const r of sourceRecords) {
    const interaction = workbenchInteractionText(r, p);
    const c = r.content;
    if (!interaction && !(c.kind === "steering" && c.origin === "user"))
      continue;
    const text = textPage(
      interaction?.text ?? (c.kind === "steering" ? c.instruction : ""),
    );
    notices.push({
      id: `record:${productRunId}:${runId}:${r.id}`,
      kind: interaction ? "interaction" : "steering",
      role: interaction ? "product" : "user",
      title: interaction?.title ?? null,
      revision: r.revision,
      position: [anchor, r.sequence],
      content: text.text,
      omittedBytes: text.omittedBytes,
      productRunId,
      runId,
      sourceId: r.id,
      modelItemIds: [],
      detail: detail(r.id),
      artifactIds: [],
      disposition:
        interaction?.status ?? (c.kind === "steering" ? c.disposition : null),
    });
  }
  const missing =
    commands.filter((c) => !c.origin).length +
    labels.filter((l) => !l.parentOrigin).length;
  if (missing)
    notices.push({
      kind: "notice",
      id: `unattributed:${productRunId}:${runId}`,
      role: "product",
      title: "Unattributed work",
      revision: p.product.sequence,
      position: [anchor, Number.MAX_SAFE_INTEGER],
      content: `${missing} retained work items have no recorded response origin.`,
      omittedBytes: 0,
      productRunId,
      runId,
      sourceId: runId,
      modelItemIds: [],
      detail: null,
      artifactIds: [],
      disposition: null,
    });
  for (const turn of turns.values()) {
    turn.blocks.sort((a, b) => a.ordinal - b.ordinal);
    turn.entry = {
      ...turn.entry,
      modelItemIds: [...new Set(turn.blocks.map((b) => b.modelItemId))],
      blockCount: turn.blocks.length,
    };
  }
  return {
    turns: [...turns.values()].filter((t) => t.blocks.length),
    notices,
    placedMessages,
  };
}

function commandActivity(
  c: HelarcCommandProgress,
  active: boolean,
): D.ConversationActivityItem {
  const phases: Record<string, string> = {
    starting: "Starting",
    running: "Running",
    draining: "Finishing output capture",
    stopping: "Stopping",
    terminating: "Stopping",
    unresolved: "Process state unresolved",
  };
  const phase = phases[c.phase] ?? "Execution pending";
  const settled = c.phase === "settled";
  return {
    id: c.executionId,
    runId: c.runId,
    kind: "command",
    title: short(c.command ?? "Shell command"),
    attribution: null,
    state: settled ? "settled" : active ? "ongoing" : "inactive",
    status: settled
      ? c.exitCode != null
        ? `Exited with code ${c.exitCode}`
        : `Ended: ${c.outcome ?? "status unavailable"}`
      : active
        ? phase
        : `Last observed: ${phase}`,
    startedAt: c.startedAt ?? null,
    endedAt: c.completedAt ?? null,
    detail: { kind: "command", executionId: c.executionId },
    child: null,
  };
}
