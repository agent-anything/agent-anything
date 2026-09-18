import {
  createHelarcRunProjection,
  type HelarcRunProjection,
  type HelarcRunPresentationRecord,
} from "@agent-anything/helarc/run";
import type { HelarcThreadRecord } from "@agent-anything/helarc/work-context";
import {
  projectRun,
  projectWorkbenchActivity,
} from "../HelarcDesktopProjection.js";
import type { HelarcHostActiveRun } from "../run/HelarcHostRunComposition.js";
import type {
  CommandOutputPage,
  CommandOutputQuery,
  ThreadRunSummary,
  WorkbenchItemPage,
  WorkbenchItemQuery,
  WorkbenchPage,
  WorkbenchQuery,
  WorkbenchRejected,
  WorkbenchScope,
} from "../../shared/HelarcWorkbench.js";
import type { CommandOutputRegistry } from "./CommandOutputRegistry.js";

export interface WorkbenchQuerySources {
  loadThread(threadId: string): Promise<HelarcThreadRecord | null>;
  live(
    threadId: string,
    productRunId: string,
  ): { projection: HelarcRunProjection; handle: HelarcHostActiveRun } | null;
  readonly outputs: CommandOutputRegistry;
}
export class HelarcWorkbenchQueries {
  constructor(private readonly sources: WorkbenchQuerySources) {}
  async listThreadRuns(input: {
    threadId: string;
  }): Promise<
    { status: "page"; runs: readonly ThreadRunSummary[] } | WorkbenchRejected
  > {
    if (!token(input?.threadId)) return rejected("invalid_query");
    try {
      const thread = await this.sources.loadThread(input.threadId);
      if (!thread) return rejected("not_found");
      return {
        status: "page",
        runs: thread.runs
          .map((run) => {
            const live = this.sources.live(input.threadId, run.id);
            return {
              productRunId: run.id,
              harnessRunId:
                run.harnessRunId ?? live?.projection.harnessRunId ?? null,
              startedAt: run.startedAt,
              completedAt: run.terminal?.host.completedAt ?? null,
              status:
                run.terminal?.host.status ??
                (live ? live.projection.display.status : "inactive"),
              live: live !== null && !live.projection.display.terminal,
              objective:
                thread.messages
                  .find((message) => message.id === run.triggeringMessageId)
                  ?.content.slice(0, 512) ?? "",
            };
          })
          .slice(-200),
      };
    } catch {
      return rejected("read_failed");
    }
  }
  async readRunWorkbench(
    query: WorkbenchQuery,
  ): Promise<WorkbenchPage | WorkbenchRejected> {
    if (
      !scopeValid(query) ||
      typeof query.includeDescendants !== "boolean" ||
      (query.cursor !== null && !token(query.cursor)) ||
      (query.limit !== undefined &&
        (!Number.isSafeInteger(query.limit) ||
          query.limit < 1 ||
          query.limit > 200))
    )
      return rejected("invalid_query");
    try {
      const resolved = await this.resolve(query);
      if (!resolved) return rejected("not_found");
      const { projection, live, recordedAt } = resolved;
      const presentation = projection.product.presentation;
      const identity = [
        query.threadId,
        query.productRunId,
        query.runId,
        query.includeDescendants,
      ];
      let after = 0;
      let commandOffset = 0;
      let activityOffset = 0;
      const revision = projection.product.sequence;
      if (query.cursor) {
        const cursor = decode(query.cursor);
        if (
          !cursor ||
          JSON.stringify(cursor.identity) !== JSON.stringify(identity) ||
          cursor.revision !== revision ||
          !Number.isSafeInteger(cursor.after) ||
          (cursor.after as number) < 0 ||
          !Number.isSafeInteger(cursor.commandOffset) ||
          (cursor.commandOffset as number) < 0 ||
          !Number.isSafeInteger(cursor.activityOffset) ||
          (cursor.activityOffset as number) < 0
        )
          return rejected("stale_cursor");
        after = cursor.after as number;
        commandOffset = cursor.commandOffset as number;
        activityOffset = cursor.activityOffset as number;
      }
      const runIds = new Set([query.runId]);
      if (query.includeDescendants) {
        for (let pass = 0; pass < projection.host.runTree.nodes.length; pass++)
          for (const node of projection.host.runTree.nodes)
            if (node.parentRunId && runIds.has(node.parentRunId))
              runIds.add(node.runId);
      }
      const records: HelarcRunPresentationRecord[] = [];
      const commands: WorkbenchPage["commands"][number][] = [];
      const activity: WorkbenchPage["activity"][number][] = [];
      const page: WorkbenchPage = {
        status: "page",
        scope: {
          threadId: query.threadId,
          productRunId: query.productRunId,
          runId: query.runId,
        },
        live,
        recordedAt,
        revision,
        run: projectRun(projection),
        labels: presentation.labels,
        plans: Object.fromEntries(
          Object.entries(presentation.plans).filter(([id]) => runIds.has(id)),
        ),
        records,
        commands,
        activity,
        nextCursor: null,
        omittedRecords: presentation.omittedRecords,
        finalSource: projection.product.result?.output.source ?? {
          kind: "product_status",
        },
      };
      // Reserve space for the exact continuation cursor, including encoded scope identity.
      let remaining =
        256 * 1024 - Buffer.byteLength(JSON.stringify(page)) - 24 * 1024;
      if (remaining <= 0) return rejected("read_failed");
      const take = <T>(source: readonly T[], target: T[], budget: number) => {
        let used = 0;
        for (const item of source) {
          const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
          if (used + bytes > budget || target.length >= (query.limit ?? 100))
            break;
          target.push(item);
          used += bytes;
        }
        remaining -= used;
      };
      const commandCandidates = projection.product.commands
        .filter((command) => runIds.has(command.runId))
        .slice(commandOffset);
      const activityCandidates = projection.product.activity
        .filter((item) => runIds.has(item.source.runId))
        .slice(-100)
        .map(projectWorkbenchActivity)
        .slice(activityOffset);
      take(commandCandidates, commands, Math.floor(remaining / 3));
      take(activityCandidates, activity, Math.floor(remaining / 4));
      const candidates = presentation.records.filter(
        (item) => runIds.has(item.runId) && item.sequence > after,
      );
      for (const entry of candidates) {
        const preview =
          entry.content.kind === "assistant_text" &&
          entry.content.text.length > 8192
            ? {
                ...entry,
                content: {
                  ...entry.content,
                  text: entry.content.text.slice(0, 8192),
                  omittedBytes:
                    entry.content.omittedBytes +
                    Buffer.byteLength(entry.content.text.slice(8192)),
                },
              }
            : entry;
        const bytes = Buffer.byteLength(JSON.stringify(preview));
        if (records.length >= (query.limit ?? 100) || bytes + 1 > remaining)
          break;
        records.push(preview);
        remaining -= bytes + 1;
      }
      // A large individual command may consume the remaining page after other content.
      if (commands.length === 0 && commandCandidates.length)
        take(commandCandidates, commands, remaining);
      if (activity.length === 0 && activityCandidates.length)
        take(activityCandidates, activity, remaining);
      const more =
        candidates.length > records.length ||
        commandCandidates.length > commands.length ||
        activityCandidates.length > activity.length;
      if (more && records.length + commands.length + activity.length === 0)
        return rejected("read_failed");
      return {
        ...page,
        nextCursor: more
          ? encode({
              identity,
              revision,
              after: records.at(-1)?.sequence ?? after,
              commandOffset: commandOffset + commands.length,
              activityOffset: activityOffset + activity.length,
            })
          : null,
      };
    } catch {
      return rejected("read_failed");
    }
  }
  async readWorkbenchItem(
    query: WorkbenchItemQuery,
  ): Promise<WorkbenchItemPage> {
    if (
      !scopeValid(query) ||
      !token(query.itemId) ||
      (query.offset !== undefined &&
        (!Number.isSafeInteger(query.offset) || query.offset < 0))
    )
      return rejected("invalid_query");
    try {
      const resolved = await this.resolve(query);
      const record = resolved?.projection.product.presentation.records.find(
        (item) => item.id === query.itemId && item.runId === query.runId,
      );
      if (!record) return rejected("not_found");
      const value =
        record.content.kind === "assistant_text"
          ? record.content.text
          : JSON.stringify(record, null, 2);
      const offset = query.offset ?? 0;
      if (offset > value.length) return rejected("invalid_query");
      // UTF-16 slicing bounded to at most 64 KiB of UTF-8, without splitting surrogate pairs.
      let end = Math.min(value.length, offset + 16 * 1024);
      if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--;
      return {
        status: "page",
        itemId: query.itemId,
        text: value.slice(offset, end),
        nextOffset: end < value.length ? end : null,
        omittedBytes:
          record.content.kind === "assistant_text"
            ? record.content.omittedBytes
            : 0,
      };
    } catch {
      return rejected("read_failed");
    }
  }
  async readCommandOutput(
    query: CommandOutputQuery,
  ): Promise<CommandOutputPage> {
    if (
      !scopeValid(query) ||
      !token(query.executionId) ||
      (query.cursor !== null && !token(query.cursor))
    )
      return rejected("invalid_query");
    try {
      const resolved = await this.resolve(query);
      if (
        !resolved ||
        !resolved.projection.product.commands.some(
          (item) =>
            item.runId === query.runId &&
            item.executionId === query.executionId,
        )
      )
        return rejected("not_found");
      const identity = [
        query.threadId,
        query.productRunId,
        query.runId,
        query.executionId,
      ];
      const cursor = query.cursor ? decode(query.cursor) : null;
      if (
        query.cursor &&
        (!cursor ||
          JSON.stringify(cursor.identity) !== JSON.stringify(identity) ||
          typeof cursor.position !== "string")
      )
        return rejected("invalid_query");
      let page: CommandOutputPage | null = null;
      if (resolved.handle) {
        try {
          if (cursor && cursor.source !== "live")
            return { status: "cursor_reset_required" };
          const output = resolved.handle.readCommandOutput(
            query.runId,
            query.executionId,
            cursor?.position as string | undefined,
          );
          page = {
            status: "page",
            source: "live",
            stdout: output.stdout,
            stderr: output.stderr,
            nextCursor: output.nextCursor,
            hasMore: output.hasMore,
            settled: output.snapshot.phase === "settled",
          };
        } catch (error) {
          if ((error as Error).message === "process_output_cursor_invalid")
            return rejected("invalid_query");
        }
      }
      if (!page) {
        if (cursor && cursor.source !== "retained")
          return { status: "cursor_reset_required" };
        page = await this.sources.outputs.read(
          query,
          cursor?.position as string | undefined,
        );
      }
      return page.status === "page"
        ? {
            ...page,
            nextCursor: encode({
              identity,
              source: page.source,
              position: page.nextCursor,
            }),
          }
        : page;
    } catch {
      return rejected("read_failed");
    }
  }
  private async resolve(scope: WorkbenchScope) {
    const thread = await this.sources.loadThread(scope.threadId);
    const stored = thread?.runs.find((run) => run.id === scope.productRunId);
    if (!stored) return null;
    const active = stored.terminal
      ? null
      : this.sources.live(scope.threadId, scope.productRunId);
    const retained = stored.terminal?.finalProjection ?? stored.lastProjection;
    const projection =
      active?.projection ??
      (retained
        ? createHelarcRunProjection({
            host: stored.terminal
              ? {
                  ...retained.host,
                  status: stored.terminal.host.status,
                  terminal: stored.terminal.host,
                }
              : retained.host,
            product: stored.terminal
              ? { ...retained.product, result: stored.terminal.product }
              : retained.product,
          })
        : null);
    if (
      !projection ||
      !projection.host.runTree.nodes.some((node) => node.runId === scope.runId)
    )
      return null;
    return {
      projection,
      live: active !== null && !projection.display.terminal,
      handle: active?.handle ?? null,
      recordedAt: retained?.recordedAt ?? stored.updatedAt,
    };
  }
}
function token(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}
function scopeValid(value: WorkbenchScope | null): value is WorkbenchScope {
  return (
    value !== null &&
    typeof value === "object" &&
    token(value.threadId) &&
    token(value.productRunId) &&
    token(value.runId)
  );
}
function rejected(code: WorkbenchRejected["code"]): WorkbenchRejected {
  return { status: "rejected", code };
}
function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decode(value: string): Record<string, unknown> | null {
  try {
    const result = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return result !== null && typeof result === "object" ? result : null;
  } catch {
    return null;
  }
}
