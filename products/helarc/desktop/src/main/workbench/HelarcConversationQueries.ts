import { createHash } from "node:crypto";
import { createHelarcRunProjection } from "@agent-anything/helarc/run";
import type { HelarcThreadRecord } from "@agent-anything/helarc/work-context";
import type { WorkbenchQuerySources } from "./HelarcWorkbenchQueries.js";
import type * as D from "../../shared/HelarcWorkbench.js";
import {
  outputModelItems,
  presentConversationWork,
  type ConversationTurn,
} from "./ConversationPresentation.js";
import {
  decodePosition,
  encodePosition,
  fitsPage,
  readRejected,
  readToken,
  taskScopeValid,
  textPage,
} from "./WorkbenchReadLimits.js";

const compare = (a: readonly number[], b: readonly number[]) =>
  a[0]! - b[0]! || a[1]! - b[1]!;
const fingerprint = (values: unknown) =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex");
const identity = (q: D.ConversationQuery) => [
  q.threadId,
  q.scope?.productRunId ?? null,
  q.scope?.runId ?? null,
];

/** Read-only joins over retained Product facts, never a new conversation or execution store. */
export class HelarcConversationQueries {
  constructor(private readonly sources: WorkbenchQuerySources) {}

  async readConversation(
    q: D.ConversationQuery,
  ): Promise<D.ConversationPage | D.WorkbenchRejected> {
    if (
      !readToken(q?.threadId) ||
      !q.position ||
      !["latest", "before", "window"].includes(q.position.kind) ||
      (q.scope !== undefined &&
        (!taskScopeValid(q.scope) || q.scope.threadId !== q.threadId)) ||
      (q.position.kind === "before" && !readToken(q.position.cursor)) ||
      (q.position.kind === "window" &&
        (!readToken(q.position.first) ||
          !readToken(q.position.last) ||
          (q.position.cursor !== undefined && !readToken(q.position.cursor))))
    )
      return readRejected("invalid_query");
    try {
      const assembled = await this.assemble(q);
      if (!assembled) return readRejected("not_found");
      const { entries: all, revision, omittedRecords } = assembled;
      let candidates = all;
      const pageIdentity = identity(q);
      if (q.position.kind === "before") {
        const cursor = decodePosition(q.position.cursor);
        const anchor = all.find((e) => e.id === cursor?.anchor);
        if (
          !cursor ||
          JSON.stringify(cursor.identity) !== JSON.stringify(pageIdentity) ||
          !anchor ||
          cursor.prefix !==
            fingerprint(
              all
                .filter((e) => compare(e.position, anchor.position) < 0)
                .map((e) => e.id),
            )
        )
          return readRejected("stale_cursor");
        candidates = all.filter(
          (e) => compare(e.position, anchor.position) < 0,
        );
      }
      if (q.position.kind === "window") {
        const position = q.position;
        const first = all.findIndex((e) => e.id === position.first),
          last = all.findIndex((e) => e.id === position.last);
        if (first < 0 || last < first) return readRejected("stale_cursor");
        candidates = all.slice(first, last + 1);
        if (position.cursor) {
          const cursor = decodePosition(position.cursor);
          const offset = candidates.findIndex((e) => e.id === cursor?.after);
          if (
            !cursor ||
            JSON.stringify(cursor.identity) !== JSON.stringify(pageIdentity) ||
            cursor.first !== position.first ||
            cursor.last !== position.last ||
            offset < 0
          )
            return readRejected("stale_cursor");
          candidates = candidates.slice(offset + 1);
        }
      }
      const entries: D.ConversationEntry[] = [];
      const page: D.ConversationPage = {
        status: "page",
        threadId: q.threadId,
        revision,
        entries,
        latestPosition: all.at(-1)?.position ?? null,
        previousCursor: null,
        omittedRecords,
        nextWindowCursor: null,
      };
      const window = q.position.kind === "window";
      for (const entry of window ? candidates : [...candidates].reverse()) {
        const next = window ? [...entries, entry] : [entry, ...entries];
        if (
          entries.length === 100 ||
          !fitsPage({ ...page, entries: next }, 224 * 1024)
        )
          break;
        if (window) entries.push(entry);
        else entries.unshift(entry);
      }
      if (candidates.length && !entries.length)
        return readRejected("read_failed");
      const first = entries[0];
      const before = first
        ? all.filter((e) => compare(e.position, first.position) < 0)
        : [];
      const previousCursor =
        first && before.length
          ? encodePosition({
              identity: pageIdentity,
              anchor: first.id,
              prefix: fingerprint(before.map((e) => e.id)),
            })
          : null;
      const nextWindowCursor =
        q.position.kind === "window" && entries.length < candidates.length
          ? encodePosition({
              identity: pageIdentity,
              first: q.position.first,
              last: q.position.last,
              after: entries.at(-1)!.id,
            })
          : null;
      const result = { ...page, previousCursor, nextWindowCursor };
      return fitsPage(result) &&
        (!previousCursor || readToken(previousCursor)) &&
        (!nextWindowCursor || readToken(nextWindowCursor))
        ? result
        : readRejected("read_failed");
    } catch {
      return readRejected("read_failed");
    }
  }

  async readConversationTurn(
    q: D.ConversationTurnQuery,
  ): Promise<D.ConversationTurnPage | D.WorkbenchRejected> {
    if (
      !taskScopeValid(q) ||
      !readToken(q.turnId) ||
      (q.cursor !== null && !readToken(q.cursor))
    )
      return readRejected("invalid_query");
    try {
      const assembled = await this.assemble({
        threadId: q.threadId,
        scope: q,
        position: { kind: "latest" },
      });
      const turn = assembled?.turns.find((t) => t.entry.turnId === q.turnId);
      if (!turn) return readRejected("not_found");
      return turnPage(turn, q.cursor, 224 * 1024, 100);
    } catch {
      return readRejected("read_failed");
    }
  }

  private async assemble(q: D.ConversationQuery) {
    const thread = await this.sources.loadThread(q.threadId);
    if (!thread || thread.thread.id !== q.threadId) return null;
    const entries: D.ConversationEntry[] = [],
      turns: ConversationTurn[] = [];
    const placed = new Set<string>();
    let matched = q.scope === undefined,
      omittedRecords = 0,
      revision = thread.thread.revision;
    for (const work of thread.runs) {
      if (q.scope && q.scope.productRunId !== work.id) continue;
      const live = work.terminal
        ? null
        : this.sources.live(q.threadId, work.id);
      const retained = work.terminal?.finalProjection ?? work.lastProjection;
      const p =
        live?.projection ??
        (retained
          ? createHelarcRunProjection({
              host: work.terminal
                ? {
                    ...retained.host,
                    status: work.terminal.host.status,
                    terminal: work.terminal.host,
                  }
                : retained.host,
              product: work.terminal
                ? { ...retained.product, result: work.terminal.product }
                : retained.product,
            })
          : null);
      if (!p) continue;
      const runId = q.scope?.runId ?? p.host.runId;
      if (
        runId !== p.host.runId &&
        !p.host.runTree.nodes.some((n) => n.runId === runId)
      )
        continue;
      matched = true;
      const anchor = thread.messages.find(
        (m) => m.id === work.triggeringMessageId,
      );
      if (!anchor) continue;
      const presentation = presentConversationWork(
        thread,
        work.id,
        anchor.sequence,
        p,
        !!live,
        runId,
      );
      for (const id of presentation.placedMessages) placed.add(id);
      entries.push(...presentation.notices);
      turns.push(...presentation.turns);
      omittedRecords +=
        p.product.presentation.omittedRecords +
        p.product.presentation.omittedActiveCalls;
      revision += p.product.sequence + p.host.sequence;
    }
    if (!matched) return null;
    for (const turn of turns) {
      const page = turnPage(turn, null, 16 * 1024, 12);
      if (page.status !== "page") throw Error("Turn preview exceeds its bound");
      entries.push({
        ...turn.entry,
        modelItemIds: [...new Set(page.blocks.map((b) => b.modelItemId))],
        blocks: page.blocks,
        nextCursor: page.nextCursor,
      });
    }
    // Root Messages only. Delegated scopes never borrow the root's final answer.
    if (!q.scope)
      for (const m of thread.messages)
        if (!placed.has(m.id)) entries.push(messageEntry(thread, m));
    entries.sort(
      (a, b) => compare(a.position, b.position) || a.id.localeCompare(b.id),
    );
    return { entries, turns, revision, omittedRecords };
  }
}

function turnPage(
  turn: ConversationTurn,
  token: string | null,
  budget: number,
  maximum: number,
): D.ConversationTurnPage | D.WorkbenchRejected {
  const { entry, blocks: all } = turn;
  const identity = [
    entry.scope.threadId,
    entry.scope.productRunId,
    entry.scope.runId,
    entry.turnId,
  ];
  const cursor = token ? decodePosition(token) : null;
  const keys = all.map((b) => [b.id, b.ordinal]);
  const shape = fingerprint(keys);
  if (
    token &&
    (!cursor ||
      JSON.stringify(cursor.identity) !== JSON.stringify(identity) ||
      cursor.shape !== shape ||
      !Number.isSafeInteger(cursor.offset) ||
      (cursor.offset as number) < 0 ||
      (cursor.offset as number) >= all.length)
  )
    return readRejected("stale_cursor");
  const offset = (cursor?.offset as number | undefined) ?? 0;
  const blocks: D.ConversationBlock[] = [];
  const page: D.ConversationTurnPage = {
    status: "page",
    scope: entry.scope,
    turnId: entry.turnId,
    revision: entry.revision,
    blocks,
    nextCursor: null,
    blockCount: all.length,
    partial: entry.partial,
  };
  for (const block of all.slice(offset)) {
    if (
      blocks.length === maximum ||
      !fitsPage({ ...page, blocks: [...blocks, block] }, budget)
    )
      break;
    blocks.push(block);
  }
  if (!blocks.length && all.length) return readRejected("read_failed");
  const nextCursor =
    offset + blocks.length < all.length
      ? encodePosition({ identity, shape, offset: offset + blocks.length })
      : null;
  const result = { ...page, nextCursor };
  return fitsPage(result) && (!nextCursor || readToken(nextCursor))
    ? result
    : readRejected("read_failed");
}

function messageEntry(
  thread: HelarcThreadRecord,
  m: HelarcThreadRecord["messages"][number],
): D.ConversationMessageEntry {
  const work = thread.runs.find((r) => r.id === m.correlation.runId);
  const runId = work?.harnessRunId ?? null;
  const text = textPage(m.content);
  return {
    kind: "message",
    id: `message:${m.id}`,
    title: null,
    role: m.role,
    revision: m.sequence,
    position: [m.sequence, 0],
    content: text.text,
    omittedBytes: text.omittedBytes,
    productRunId: m.correlation.runId,
    runId,
    sourceId: m.id,
    modelItemIds: outputModelItems(
      m.metadata.outputSource as D.HelarcOutputSource | undefined,
    ),
    detail:
      work && runId
        ? {
            threadId: thread.thread.id,
            productRunId: work.id,
            runId,
            itemId: `message:${m.id}`,
          }
        : null,
    artifactIds: m.relatedArtifactIds,
    disposition: null,
  };
}
