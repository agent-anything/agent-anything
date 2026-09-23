import {
  createHelarcRunProjection,
  type HelarcRunProjection,
} from "@agent-anything/helarc/run";
import type { HelarcThreadRecord } from "@agent-anything/helarc/work-context";
import type { HelarcHostActiveRun } from "../run/HelarcHostRunComposition.js";
import type {
  CommandOutputPage,
  CommandOutputQuery,
  ThreadRunSummary,
  WorkbenchItemPage,
  WorkbenchItemQuery,
  WorkbenchRejected,
  WorkbenchScope,
} from "../../shared/HelarcWorkbench.js";
import type { CommandOutputRegistry } from "./CommandOutputRegistry.js";
import { HelarcCollaborationQueries } from "./HelarcCollaborationQueries.js";
import { fitsPage, textPage, validOffset } from "./WorkbenchReadLimits.js";

export interface WorkbenchQuerySources {
  loadThread(threadId: string): Promise<HelarcThreadRecord | null>;
  live(
    threadId: string,
    productRunId: string,
  ): { projection: HelarcRunProjection; handle: HelarcHostActiveRun } | null;
  readonly outputs: CommandOutputRegistry;
}
export class HelarcWorkbenchQueries {
  readonly collaboration: HelarcCollaborationQueries;
  constructor(private readonly sources: WorkbenchQuerySources) {
    this.collaboration = new HelarcCollaborationQueries(sources, scope => this.resolve(scope));
  }
  readConversation = (query: Parameters<HelarcCollaborationQueries["readConversation"]>[0]) => this.collaboration.readConversation(query);
  readCurrentWork = (query: Parameters<HelarcCollaborationQueries["readCurrentWork"]>[0]) => this.collaboration.readCurrentWork(query);
  readTaskDetails = (query: Parameters<HelarcCollaborationQueries["readTaskDetails"]>[0]) => this.collaboration.readTaskDetails(query);
  readWorkHistory = (query: Parameters<HelarcCollaborationQueries["readWorkHistory"]>[0]) => this.collaboration.readWorkHistory(query);
  readArtifactContent = (query: Parameters<HelarcCollaborationQueries["readArtifactContent"]>[0]) => this.collaboration.readArtifactContent(query);
  readResponsePreview = (query: Parameters<HelarcCollaborationQueries["readResponsePreview"]>[0]) => this.collaboration.readResponsePreview(query);
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
  async readCommandDetails(query: WorkbenchScope & { executionId: string }) {
    if (!scopeValid(query) || !token(query.executionId)) return rejected("invalid_query");
    try {
      const resolved = await this.resolve(query);
      const command = resolved?.projection.product.commands.find(c => c.runId === query.runId && c.executionId === query.executionId);
      if (!command) return rejected("not_found");
      const page = { status: "page" as const, command, live: resolved!.live };
      return fitsPage(page) ? page : rejected("read_failed");
    } catch { return rejected("read_failed"); }
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
      if (!resolved) return rejected("not_found");
      if (query.itemId.startsWith("message:")) {
        const thread = await this.sources.loadThread(query.threadId);
        const message = thread?.messages.find(m => `message:${m.id}` === query.itemId &&
          m.correlation.runId === query.productRunId);
        if (!message || query.runId !== resolved.projection.harnessRunId) return rejected("not_found");
        const offset = query.offset ?? 0;
        if (!validOffset(message.content,offset)) return rejected("invalid_query");
        const page = textPage(message.content,offset,16*1024,
          64*1024-Buffer.byteLength(JSON.stringify(query.itemId))-256);
        return {status:"page",itemId:query.itemId,text:page.text,
          nextOffset:page.end < message.content.length ? page.end : null,omittedBytes:0};
      }
      const record = resolved?.projection.product.presentation.records.find(
        (item) => item.id === query.itemId && item.runId === query.runId,
      );
      if (!record) return rejected("not_found");
      const value =
        record.content.kind === "assistant_text"
          ? record.content.text
          : record.content.kind === "steering" ? record.content.instruction
          : JSON.stringify(record, null, 2);
      const offset = query.offset ?? 0;
      if (!validOffset(value,offset)) return rejected("invalid_query");
      const page = textPage(value,offset,16*1024,
        64*1024-Buffer.byteLength(JSON.stringify(query.itemId))-256);
      return {
        status: "page",
        itemId: query.itemId,
        text: page.text,
        nextOffset: page.end < value.length ? page.end : null,
        omittedBytes:
          record.content.kind === "assistant_text" || record.content.kind === "steering"
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
    if (!thread || thread.thread.id !== scope.threadId) return null;
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
