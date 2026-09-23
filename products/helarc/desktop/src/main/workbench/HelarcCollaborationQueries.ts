import { createHash } from "node:crypto";
import type {
  HelarcRunProjection,
  HelarcRunPresentationRecord,
} from "@agent-anything/helarc/run";
import type { HelarcThreadRecord } from "@agent-anything/helarc/work-context";
import type { WorkbenchQuerySources } from "./HelarcWorkbenchQueries.js";
import type * as D from "../../shared/HelarcWorkbench.js";
import {
  decodePosition,
  encodePosition,
  fitsPage,
  readRejected,
  readToken,
  taskScopeValid,
  textPage,
  validOffset,
  workScopeValid,
} from "./WorkbenchReadLimits.js";

interface ResolvedWork {
  readonly projection: HelarcRunProjection;
  readonly live: boolean;
}
export class HelarcCollaborationQueries {
  constructor(
    private readonly sources: WorkbenchQuerySources,
    private readonly resolve: (
      scope: D.WorkbenchScope,
    ) => Promise<ResolvedWork | null>,
  ) {}

  async readConversation(
    query: D.ConversationQuery,
  ): Promise<D.ConversationPage | D.WorkbenchRejected> {
    if (
      !readToken(query?.threadId) ||
      !query.position ||
      !["latest", "before"].includes(query.position.kind) ||
      (query.position.kind === "before" && !readToken(query.position.cursor))
    )
      return readRejected("invalid_query");
    try {
      const thread = await this.sources.loadThread(query.threadId);
      if (!thread || thread.thread.id !== query.threadId)
        return readRejected("not_found");
      const all: D.ConversationEntry[] = thread.messages.map((m) => {
        const text = textPage(m.content);
        const work = thread.runs.find((r) => r.id === m.correlation.runId);
        const rootRunId = work?.harnessRunId ?? null;
        return {
          id: `message:${m.id}`,
          revision: m.sequence,
          position: [m.sequence, 0],
          role: m.role,
          kind: "message",
          content: text.text,
          omittedBytes: text.omittedBytes,
          productRunId: m.correlation.runId,
          runId: rootRunId,
          sourceId: m.id,
          modelItemIds: (m.metadata.outputSource as D.HelarcOutputSource | undefined)?.kind === "model_text"
            ? (m.metadata.outputSource as Extract<D.HelarcOutputSource,{kind:"model_text"}>).modelItemIds : [],
          detail:
            work && rootRunId
              ? {
                  threadId: query.threadId,
                  productRunId: work.id,
                  runId: rootRunId,
                  itemId: `message:${m.id}`,
                }
              : null,
          artifactIds: m.relatedArtifactIds,
          disposition: null,
        };
      });
      let omittedRecords = 0;
      const retention: Record<string, number> = {};
      for (const work of thread.runs) {
        const live = this.sources.live(query.threadId, work.id);
        const projection =
          live?.projection ??
          work.terminal?.finalProjection ??
          work.lastProjection;
        if (!projection) continue;
        const presentation = projection.product.presentation;
        retention[work.id] = presentation.omittedRecords;
        omittedRecords += presentation.omittedRecords;
        const root = projection.host.runId;
        const anchor = thread.messages.find(
          (m) => m.id === work.triggeringMessageId,
        );
        if (!anchor) continue;
        const suppressed = new Set(
          thread.messages.flatMap((message) => {
            if (
              message.source.kind !== "agent_run" ||
              message.correlation.runId !== work.id
            )
              return [];
            const source = message.metadata.outputSource as
              | D.HelarcOutputSource
              | undefined;
            return source?.kind === "model_text" ? source.modelItemIds : [];
          }),
        );
        for (const record of presentation.records) {
          if (record.runId !== root) continue;
          const c = record.content;
          if (
            c.kind !== "assistant_text" &&
            !(c.kind === "steering" && c.origin === "user")
          )
            continue;
          if (c.kind === "assistant_text" && suppressed.has(c.modelItemId))
            continue;
          const text = textPage(
            c.kind === "assistant_text" ? c.text : c.instruction,
          );
          all.push({
            id: `record:${work.id}:${record.id}`,
            revision: record.revision,
            position: [anchor.sequence, record.sequence],
            role: c.kind === "steering" ? "user" : "assistant",
            kind: c.kind,
            content: text.text,
            omittedBytes: text.omittedBytes + c.omittedBytes,
            productRunId: work.id,
            runId: root,
            sourceId: record.id,
            modelItemIds: c.kind === "assistant_text" ? [c.modelItemId] : [],
            detail: {
              threadId: query.threadId,
              productRunId: work.id,
              runId: root,
              itemId: record.id,
            },
            artifactIds: [],
            disposition: c.kind === "steering" ? c.disposition : null,
          });
        }
      }
      all.sort((a, b) => compare(a.position, b.position));
      const retentionKey = (position: readonly number[]) =>
        createHash("sha256")
          .update(
            JSON.stringify(
              thread.runs
                .filter(
                  (work) =>
                    (thread.messages.find(
                      (m) => m.id === work.triggeringMessageId,
                    )?.sequence ?? Infinity) <= position[0]!,
                )
                .map((work) => [work.id, retention[work.id] ?? null]),
            ),
          )
          .digest("hex");
      let candidates = all;
      if (query.position.kind === "before") {
        const cursor = decodePosition(query.position.cursor);
        if (
          !cursor ||
          cursor.threadId !== query.threadId ||
          typeof cursor.anchor !== "string" ||
          typeof cursor.retention !== "string"
        )
          return readRejected("stale_cursor");
        const anchor = all.find((e) => e.id === cursor.anchor);
        if (!anchor || cursor.retention !== retentionKey(anchor.position))
          return readRejected("stale_cursor");
        candidates = all.filter(
          (e) => compare(e.position, anchor.position) < 0,
        );
      }
      const entries: D.ConversationEntry[] = [];
      const page: D.ConversationPage = {
        status: "page",
        threadId: query.threadId,
        revision: thread.thread.revision,
        entries,
        latestPosition: all.at(-1)?.position ?? null,
        previousCursor: null,
        omittedRecords,
      };
      for (const entry of [...candidates].reverse()) {
        if (
          entries.length >= 100 ||
          !fitsPage({ ...page, entries: [entry, ...entries] }, 224 * 1024)
        )
          break;
        entries.unshift(entry);
      }
      if (candidates.length && !entries.length)
        return readRejected("read_failed");
      const previousCursor =
        candidates.length > entries.length
          ? encodePosition({
              threadId: query.threadId,
              anchor: entries[0]!.id,
              retention: retentionKey(entries[0]!.position),
            })
          : null;
      if (previousCursor && previousCursor.length > 4096)
        return readRejected("read_failed");
      return fitsPage({ ...page, previousCursor })
        ? { ...page, previousCursor }
        : readRejected("read_failed");
    } catch {
      return readRejected("read_failed");
    }
  }

  async readCurrentWork(
    query: D.CurrentWorkQuery,
  ): Promise<D.CurrentWorkPage | D.WorkbenchRejected> {
    if (
      !workScopeValid(query) ||
      (query.collection !== undefined &&
        !["tasks", "calls", "commands"].includes(query.collection)) ||
      (query.cursor != null && (!query.collection || !readToken(query.cursor)))
    )
      return readRejected("invalid_query");
    try {
      const found = await this.resolveWork(query);
      if (!found) return readRejected("not_found");
      const { projection: p, live, thread, work } = found;
      const page: D.CurrentWorkPage = {
        status: "page",
        scope: { threadId: query.threadId, productRunId: query.productRunId },
        live,
        revision: p.product.sequence,
        rootRunId: p.host.runId,
        workStatus: live || work.terminal ? p.host.status : "inactive",
        tasks: [],
        plan: displayValue(p.product.presentation.plans[p.host.runId] ?? null),
        activeCalls: [],
        commands: [],
        attention: live
          ? p.host.pendingInteractions.map((i) => ({
              runId: i.runId,
              request: i.request,
              phase: i.phase,
            }))
          : [],
        context: {
          model: work.provider?.model ?? null,
          provider: work.provider?.displayName ?? null,
          permissionPreset: work.permissionPreset,
          enforcement: p.host.enforcement.selected,
          source: "bound_run",
          effectiveGrants: "not_projected",
        },
        omitted: {
          tasks: 0,
          calls: p.product.presentation.omittedActiveCalls,
          commands: 0,
        },
        nextCursors: { tasks: null, calls: null, commands: null },
        retainedFinishedCount: p.product.presentation.records.filter(
          (r) =>
            r.content.kind === "tool_call" && r.content.settlement !== null,
        ).length,
        artifactIds: thread.artifacts
          .filter((a) => a.runId === work.id)
          .map((a) => a.id),
      };
      const tasks = currentCollectionPage(
        query,
        "tasks",
        p.host.runTree.nodes.map((node) => taskSummary(p, node.runId, live)),
        80 * 1024,
      );
      const activeCalls = currentCollectionPage(
        query,
        "calls",
        p.product.presentation.activeCalls.map(recordPreview),
        64 * 1024,
      );
      const commands = currentCollectionPage(
        query,
        "commands",
        p.product.commands
          .filter((c) => c.phase !== "settled")
          .map((c) => ({
            ...c,
            command: c.command?.slice(0, 2048),
            cwd: c.cwd?.slice(0, 2048),
          })),
        64 * 1024,
      );
      if (!tasks || !activeCalls || !commands)
        return readRejected("stale_cursor");
      const result = {
        ...page,
        tasks: tasks.items,
        activeCalls: activeCalls.items,
        commands: commands.items,
        nextCursors: {
          tasks: tasks.nextCursor,
          calls: activeCalls.nextCursor,
          commands: commands.nextCursor,
        },
        omitted: {
          tasks: tasks.omitted,
          calls: activeCalls.omitted + page.omitted.calls,
          commands: commands.omitted,
        },
      };
      return fitsPage(result) ? result : readRejected("read_failed");
    } catch {
      return readRejected("read_failed");
    }
  }

  async readTaskDetails(
    query: D.WorkbenchScope,
  ): Promise<D.TaskDetailsPage | D.WorkbenchRejected> {
    if (!taskScopeValid(query)) return readRejected("invalid_query");
    try {
      const resolved = await this.resolve(query);
      const thread = await this.sources.loadThread(query.threadId);
      if (!resolved || !thread) return readRejected("not_found");
      const p = resolved.projection;
      const page: D.TaskDetailsPage = {
        status: "page",
        scope: scopeOnly(query),
        live: resolved.live,
        task: taskSummary(p, query.runId, resolved.live),
        plan: displayValue(p.product.presentation.plans[query.runId] ?? null),
        retries:
          query.runId === p.host.runId ? displayValue(p.host.retry) : null,
        artifactIds: thread.artifacts
          .filter(
            (a) =>
              a.runId === query.productRunId &&
              (query.runId === p.host.runId ||
                a.sourceRefs.some(
                  (r) => r.kind === "run" && r.id === query.runId,
                )),
          )
          .map((a) => a.id),
        diagnostics: displayValue({
          qualification: p.product.qualification,
          continuation: p.product.continuation,
        }),
      };
      return fitsPage(page) ? page : readRejected("read_failed");
    } catch {
      return readRejected("read_failed");
    }
  }

  async readWorkHistory(
    query: D.WorkHistoryQuery,
  ): Promise<D.WorkHistoryPage | D.WorkbenchRejected> {
    if (
      !taskScopeValid(query) ||
      !["operations", "assistant", "commands"].includes(query.collection) ||
      (query.cursor !== null && !readToken(query.cursor))
    )
      return readRejected("invalid_query");
    try {
      const resolved = await this.resolve(query);
      if (!resolved) return readRejected("not_found");
      const presentation = resolved.projection.product.presentation;
      if (query.collection === "commands") {
        const all = resolved.projection.product.commands.filter(c => c.runId === query.runId && c.phase === "settled");
        const identity = [query.threadId,query.productRunId,query.runId,"commands"];
        const cursor = query.cursor ? decodePosition(query.cursor) : null;
        const anchor = cursor ? all.findIndex(c => c.executionId === cursor.before) : all.length;
        if (query.cursor && (!cursor || JSON.stringify(cursor.identity) !== JSON.stringify(identity) || anchor < 0))
          return readRejected("stale_cursor");
        const selected = boundedCollection(all.slice(0,anchor).reverse().map(c => ({...c, command:c.command?.slice(0,2048),cwd:c.cwd?.slice(0,2048)})),224*1024,100);
        const commands = selected.items.reverse();
        const page: D.WorkHistoryPage = {status:"page",scope:scopeOnly(query),collection:"commands",records:[],commands,omittedRecords:0,
          previousCursor:selected.omitted ? encodePosition({identity,before:commands[0]!.executionId}) : null};
        return fitsPage(page) ? page : readRejected("read_failed");
      }
      const identity = [
        query.threadId,
        query.productRunId,
        query.runId,
        query.collection,
      ];
      const cursor = query.cursor ? decodePosition(query.cursor) : null;
      if (
        query.cursor &&
        (!cursor ||
          JSON.stringify(cursor.identity) !== JSON.stringify(identity) ||
          cursor.omitted !== presentation.omittedRecords ||
          !Number.isSafeInteger(cursor.before))
      )
        return readRejected("stale_cursor");
      const candidates = presentation.records
        .filter(
          (r) =>
            r.runId === query.runId &&
            (!cursor || r.sequence < (cursor.before as number)) &&
            (query.collection === "assistant"
              ? r.content.kind === "assistant_text"
              : r.content.kind === "tool_call" &&
                r.content.settlement !== null),
        )
        .reverse();
      const selected = boundedCollection(
        candidates.map(recordPreview),
        224 * 1024,
        100,
      );
      const records = selected.items.reverse();
      const page: D.WorkHistoryPage = {
        status: "page",
        scope: scopeOnly(query),
        collection: query.collection,
        records,
        commands: [],
        omittedRecords: presentation.omittedRecords,
        previousCursor: selected.omitted
          ? encodePosition({
              identity,
              omitted: presentation.omittedRecords,
              before: records[0]!.sequence,
            })
          : null,
      };
      return fitsPage(page) ? page : readRejected("read_failed");
    } catch {
      return readRejected("read_failed");
    }
  }

  async readArtifactContent(
    query: D.ArtifactContentQuery,
  ): Promise<D.ArtifactContentRead> {
    if (
      !readToken(query?.threadId) ||
      !readToken(query.artifactId) ||
      (query.cursor !== null && !readToken(query.cursor))
    )
      return readRejected("invalid_query");
    try {
      const thread = await this.sources.loadThread(query.threadId);
      const artifact = thread?.artifacts.find(
        (a) => a.id === query.artifactId && a.threadId === query.threadId,
      );
      if (!artifact) return readRejected("not_found");
      if (
        artifact.sensitivity === "secret" ||
        artifact.sensitivity === "restricted"
      )
        return { status: "unavailable", reason: "restricted" };
      if (artifact.content.kind !== "inline")
        return { status: "unavailable", reason: "unsupported_reference" };
      const revision = createHash("sha256")
        .update(JSON.stringify(artifact))
        .digest("hex");
      const value = artifact.content.value;
      const text =
        typeof value === "string" ? value : JSON.stringify(displayValue(value));
      const cursor = query.cursor ? decodePosition(query.cursor) : null;
      if (
        query.cursor &&
        (!cursor ||
          cursor.threadId !== query.threadId ||
          cursor.artifactId !== artifact.id ||
          cursor.revision !== revision ||
          !validOffset(text, cursor.offset))
      )
        return readRejected("stale_cursor");
      const details = {
        status: "page" as const,
        artifactId: artifact.id,
        revision,
        mediaType: artifact.content.mediaType,
        completeness: artifact.completeness,
        integrity: displayValue(artifact.integrity),
        limitations: artifact.limitations
          .map((s) => s.slice(0, 1024))
          .slice(0, 32),
        projected: typeof value !== "string",
      };
      const cursorAt = (offset: number) =>
        encodePosition({
          threadId: query.threadId,
          artifactId: artifact.id,
          revision,
          offset,
        });
      const reservedCursor = cursorAt(text.length);
      const contentBudget =
        64 * 1024 -
        Buffer.byteLength(
          JSON.stringify({ ...details, text: "", nextCursor: reservedCursor }),
        ) -
        64;
      if (contentBudget < 8 || reservedCursor.length > 4096)
        return readRejected("read_failed");
      const part =
        typeof value === "string"
          ? textPage(
              text,
              (cursor?.offset as number | undefined) ?? 0,
              16 * 1024,
              contentBudget,
            )
          : { text, end: text.length, omittedBytes: 0 };
      if (
        typeof value !== "string" &&
        (query.cursor !== null || Buffer.byteLength(text) > 64 * 1024)
      )
        return readRejected("invalid_query");
      const result: D.ArtifactContentRead = {
        ...details,
        text: part.text,
        nextCursor: part.end < text.length ? cursorAt(part.end) : null,
      };
      return fitsPage(result, 64 * 1024) ? result : readRejected("read_failed");
    } catch {
      return readRejected("read_failed");
    }
  }

  async readResponsePreview(
    query: D.ResponsePreviewQuery,
  ): Promise<D.ResponsePreviewRead> {
    if (
      !taskScopeValid(query) ||
      (query.invocationId !== null && !readToken(query.invocationId)) ||
      (query.cursor !== null && !readToken(query.cursor))
    )
      return readRejected("invalid_query");
    try {
      const resolved = await this.resolve(query);
      if (!resolved) return readRejected("not_found");
      const live = this.sources.live(query.threadId, query.productRunId);
      const state =
        resolved.live && live
          ? live.handle.getResponsePreviews()
          : resolved.projection.product.responses;
      const identity = [
        query.threadId,
        query.productRunId,
        query.runId,
        query.invocationId,
      ];
      const cursor = query.cursor ? decodePosition(query.cursor) : null;
      if (
        query.cursor &&
        (!cursor ||
          JSON.stringify(cursor.identity) !== JSON.stringify(identity) ||
          cursor.omitted !== state.omittedAttempts ||
          !Number.isSafeInteger(cursor.index) ||
          (cursor.index as number) < 0)
      )
        return readRejected("stale_cursor");
      const candidates = state.attempts.filter(
        (a) =>
          a.runId === query.runId &&
          (query.invocationId === null ||
            a.invocationId === query.invocationId),
      );
      if (query.invocationId && !candidates.length)
        return readRejected("not_found");
      const attempts: D.ResponsePreviewSummary[] = [];
      let index = (cursor?.index as number | undefined) ?? 0;
      if (cursor && candidates[index]?.invocationId !== cursor.attemptId)
        return readRejected("stale_cursor");
      let partIndex = (cursor?.partIndex as number | undefined) ?? 0;
      let offset = (cursor?.offset as number | undefined) ?? 0;
      if (
        !Number.isSafeInteger(partIndex) ||
        partIndex < 0 ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        return readRejected("stale_cursor");
      const page = {
        status: "page" as const,
        scope: scopeOnly(query),
        live: resolved.live,
        revision: state.revision,
        attempts,
        omittedAttempts: state.omittedAttempts,
        nextCursor: null,
      };
      outer: for (
        ;
        index < candidates.length;
        index++, partIndex = 0, offset = 0
      ) {
        const a = candidates[index]!;
        const projected: D.ResponsePreviewSummary = {
          ...a,
          state:
            !resolved.live &&
            ["receiving", "received", "validated"].includes(a.state)
              ? "inactive"
              : a.state,
          parts: [],
        };
        const parts: D.ResponsePreviewPart[] = [];
        if (partIndex > a.parts.length) return readRejected("stale_cursor");
        for (; partIndex < a.parts.length; partIndex++, offset = 0) {
          const p = a.parts[partIndex]!;
          if (!validOffset(p.text, offset)) return readRejected("stale_cursor");
          const segment = textPage(p.text, offset, 8192);
          const part = {
            ...p,
            text: segment.text,
            offset,
            nextOffset: segment.end < p.text.length ? segment.end : null,
          };
          if (
            !fitsPage(
              {
                ...page,
                attempts: [
                  ...attempts,
                  { ...projected, parts: [...parts, part] },
                ],
              },
              224 * 1024,
            )
          ) {
            if (parts.length) attempts.push({ ...projected, parts });
            break outer;
          }
          parts.push(part);
          if (part.nextOffset !== null) {
            offset = part.nextOffset;
            attempts.push({ ...projected, parts });
            break outer;
          }
        }
        attempts.push({ ...projected, parts });
      }
      const nextCursor =
        index < candidates.length
          ? encodePosition({
              identity,
              omitted: state.omittedAttempts,
              attemptId: candidates[index]!.invocationId,
              index,
              partIndex,
              offset,
            })
          : null;
      const result = { ...page, nextCursor };
      return fitsPage(result) ? result : readRejected("read_failed");
    } catch {
      return readRejected("read_failed");
    }
  }
  private async resolveWork(scope: D.WorkScope) {
    const thread = await this.sources.loadThread(scope.threadId);
    const work = thread?.runs.find((r) => r.id === scope.productRunId);
    if (!thread || !work) return null;
    const runId =
      this.sources.live(scope.threadId, scope.productRunId)?.projection
        .harnessRunId ?? work.harnessRunId;
    if (!runId) return null;
    const resolved = await this.resolve({ ...scope, runId });
    return resolved ? { ...resolved, thread, work } : null;
  }
}
function scopeOnly(q: D.WorkbenchScope): D.WorkbenchScope {
  return { threadId: q.threadId, productRunId: q.productRunId, runId: q.runId };
}
function compare(a: readonly number[], b: readonly number[]): number {
  return a[0]! - b[0]! || a[1]! - b[1]!;
}
function taskSummary(
  p: HelarcRunProjection,
  runId: string,
  live: boolean,
): D.TaskSummary {
  const node = p.host.runTree.nodes.find((n) => n.runId === runId)!;
  const label = p.product.presentation.labels.find((l) => l.runId === runId);
  return {
    runId,
    parentRunId: node.parentRunId,
    label: label?.label ?? "Delegated work",
    objective: label?.objective ?? null,
    status: !live && node.terminal === null ? "inactive" : node.status,
    terminalCode: node.terminal?.code ?? null,
    hasPlan: p.product.presentation.plans[runId] != null,
  };
}
function currentCollectionPage<T>(
  query: D.CurrentWorkQuery,
  collection: NonNullable<D.CurrentWorkQuery["collection"]>,
  all: readonly T[],
  budget: number,
): { items: T[]; omitted: number; nextCursor: string | null } | null {
  if (query.collection && query.collection !== collection)
    return { items: [], omitted: all.length, nextCursor: null };
  const identity = [query.threadId, query.productRunId, collection];
  const revision = createHash("sha256")
    .update(JSON.stringify(all))
    .digest("hex");
  const cursor = query.cursor ? decodePosition(query.cursor) : null;
  if (
    query.cursor &&
    (!cursor ||
      JSON.stringify(cursor.identity) !== JSON.stringify(identity) ||
      cursor.revision !== revision ||
      !Number.isSafeInteger(cursor.offset) ||
      (cursor.offset as number) < 0 ||
      (cursor.offset as number) >= all.length)
  )
    return null;
  const offset = (cursor?.offset as number | undefined) ?? 0;
  const selected = boundedCollection(all.slice(offset), budget);
  if (selected.omitted && selected.items.length === 0) return null;
  const nextCursor = selected.omitted
    ? encodePosition({
        identity,
        revision,
        offset: offset + selected.items.length,
      })
    : null;
  if (nextCursor && nextCursor.length > 4096) return null;
  return { ...selected, nextCursor };
}
function boundedCollection<T>(
  all: readonly T[],
  bytes: number,
  max = 200,
): { items: T[]; omitted: number } {
  const items: T[] = [];
  for (const item of all) {
    if (items.length >= max || !fitsPage([...items, item], bytes)) break;
    items.push(item);
  }
  return { items, omitted: all.length - items.length };
}
function recordPreview(
  record: HelarcRunPresentationRecord,
): D.HelarcRunPresentationRecord {
  const c = record.content;
  if (c.kind === "assistant_text") {
    const text = textPage(c.text, 0, 2048);
    return {
      ...record,
      content: {
        ...c,
        text: text.text,
        omittedBytes: c.omittedBytes + text.omittedBytes,
      },
    };
  }
  if (c.kind === "tool_call")
    return {
      ...record,
      content: {
        ...c,
        input: displayValue(c.input, 2048),
        result: displayValue(c.result, 2048),
      },
    };
  return record;
}
// Explicit display projection, with depth, field and string bounds, not arbitrary object forwarding.
function displayValue(
  value: unknown,
  budget = 16 * 1024,
): D.HelarcPresentationValue {
  let remaining = budget;
  const visit = (v: unknown, depth: number): D.HelarcPresentationValue => {
    if (remaining <= 32 || depth > 8) return "[omitted: display limit]";
    remaining -= 32;
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string") {
      const part = textPage(v, 0, Math.floor(remaining / 6));
      remaining -= Buffer.byteLength(JSON.stringify(part.text));
      return part.text + (part.omittedBytes ? " [omitted]" : "");
    }
    if (Array.isArray(v)) {
      const out: D.HelarcPresentationValue[] = [];
      for (const x of v) {
        if (remaining <= 32) {
          out.push("[omitted]");
          break;
        }
        out.push(visit(x, depth + 1));
      }
      return out;
    }
    if (typeof v === "object" && v) {
      const out: Record<string, D.HelarcPresentationValue> = {};
      for (const [k, x] of Object.entries(v)) {
        if (
          /^(authorization|credentials?|apiKey|accessToken|refreshToken|password|secret|headers|environment|__proto__|constructor|prototype)$/i.test(
            k,
          )
        )
          continue;
        if (remaining <= 32 || k.length * 6 > remaining) {
          out.omitted = "display limit";
          break;
        }
        remaining -= k.length * 6;
        out[k] = visit(x, depth + 1);
      }
      return out;
    }
    return null;
  };
  return visit(value, 0);
}
