import {
  normalizeHelarcThreadRecord,
  type HelarcArtifact,
  type HelarcConversation,
  type HelarcMessage,
  type HelarcThreadRecord,
  type HelarcPersistedRun,
} from "@agent-anything/helarc";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createHelarcThreadSummary,
  sortHelarcThreadRecords,
  type HelarcThreadSummary,
} from "./HelarcThreadSummary.js";

export interface LegacyHelarcThreadStore {
  listThreadSummaries(): Promise<HelarcThreadSummary[]>;
  loadThread(threadId: string): Promise<HelarcThreadRecord | null>;
  createThread(record: HelarcThreadRecord): Promise<HelarcThreadRecord | null>;
  appendMessage(threadId: string, message: HelarcMessage): Promise<HelarcThreadRecord | null>;
  appendRun(threadId: string, run: HelarcPersistedRun): Promise<HelarcThreadRecord | null>;
  updateRun(threadId: string, run: HelarcPersistedRun): Promise<HelarcThreadRecord | null>;
  appendArtifact(threadId: string, artifact: HelarcArtifact): Promise<HelarcThreadRecord | null>;
}

export class LegacyFileHelarcThreadStore implements LegacyHelarcThreadStore {
  constructor(
    private readonly filePath: string,
    private readonly maxThreads = 100,
  ) {}

  async listThreadSummaries(): Promise<HelarcThreadSummary[]> {
    return sortHelarcThreadRecords(await this.readRecords()).map(createHelarcThreadSummary);
  }

  async loadThread(threadId: string): Promise<HelarcThreadRecord | null> {
    const normalizedThreadId = threadId.trim();
    const records = await this.readRecords();
    return records.find((record) => record.thread.id === normalizedThreadId) ?? null;
  }

  async createThread(record: HelarcThreadRecord): Promise<HelarcThreadRecord | null> {
    const normalized = normalizeHelarcThreadRecord(record);
    if (!normalized.ok) {
      return null;
    }

    const current = await this.readRecords();
    const nextRecords = sortHelarcThreadRecords([
      normalized.record,
      ...current.filter((item) => item.thread.id !== normalized.record.thread.id),
    ]).slice(0, this.maxThreads);

    await this.writeRecords(nextRecords);
    return normalized.record;
  }

  async appendMessage(threadId: string, message: HelarcMessage): Promise<HelarcThreadRecord | null> {
    const current = await this.loadThread(threadId);
    if (!current) {
      return null;
    }

    const conversation = findActiveConversation(current);
    if (!conversation || message.threadId !== current.thread.id || message.conversationId !== conversation.id) {
      return null;
    }

    const nextMessages = replaceById(current.messages, message);
    const nextConversation: HelarcConversation = {
      ...conversation,
      updatedAt: maxIsoDateTime(conversation.updatedAt, message.createdAt),
      messageIds: appendUnique(conversation.messageIds, message.id),
    };

    return this.saveUpdatedRecord({
      ...current,
      thread: {
        ...current.thread,
        updatedAt: maxIsoDateTime(current.thread.updatedAt, message.createdAt),
      },
      conversations: replaceById(current.conversations, nextConversation),
      messages: orderMessages(nextConversation.messageIds, nextMessages),
    });
  }

  async appendRun(threadId: string, run: HelarcPersistedRun): Promise<HelarcThreadRecord | null> {
    return this.saveRun(threadId, run);
  }

  async updateRun(threadId: string, run: HelarcPersistedRun): Promise<HelarcThreadRecord | null> {
    return this.saveRun(threadId, run);
  }

  async appendArtifact(threadId: string, artifact: HelarcArtifact): Promise<HelarcThreadRecord | null> {
    const current = await this.loadThread(threadId);
    if (!current || artifact.threadId !== current.thread.id) {
      return null;
    }

    const nextArtifacts = replaceById(current.artifacts, artifact);
    const nextRuns = artifact.runId
      ? current.runs.map((run) =>
        run.id === artifact.runId
          ? { ...run, artifactIds: appendUnique(run.artifactIds, artifact.id) }
          : run
      )
      : current.runs;

    return this.saveUpdatedRecord({
      ...current,
      thread: {
        ...current.thread,
        updatedAt: maxIsoDateTime(current.thread.updatedAt, artifact.createdAt),
      },
      runs: nextRuns,
      artifacts: nextArtifacts,
    });
  }

  private async saveRun(
    threadId: string,
    run: HelarcPersistedRun,
  ): Promise<HelarcThreadRecord | null> {
    const current = await this.loadThread(threadId);
    if (!current || run.threadId !== current.thread.id) {
      return null;
    }

    return this.saveUpdatedRecord({
      ...current,
      thread: {
        ...current.thread,
        updatedAt: maxIsoDateTime(current.thread.updatedAt, run.updatedAt),
        latestRunId: run.id,
      },
      runs: replaceById(current.runs, run),
    });
  }

  private async saveUpdatedRecord(record: HelarcThreadRecord): Promise<HelarcThreadRecord | null> {
    const normalized = normalizeHelarcThreadRecord(record);
    if (!normalized.ok) {
      return null;
    }

    const current = await this.readRecords();
    const nextRecords = sortHelarcThreadRecords([
      normalized.record,
      ...current.filter((item) => item.thread.id !== normalized.record.thread.id),
    ]).slice(0, this.maxThreads);

    await this.writeRecords(nextRecords);
    return normalized.record;
  }

  private async readRecords(): Promise<HelarcThreadRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.flatMap((item) => {
        const result = normalizeHelarcThreadRecord(item as HelarcThreadRecord);
        return result.ok ? [result.record] : [];
      });
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
  }

  private async writeRecords(records: readonly HelarcThreadRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(records, null, 2), "utf8");
  }
}

function findActiveConversation(record: HelarcThreadRecord): HelarcConversation | null {
  return record.conversations.find((conversation) =>
    conversation.id === record.thread.activeConversationId
  ) ?? null;
}

function replaceById<T extends { id: string }>(items: readonly T[], item: T): T[] {
  return [
    ...items.filter((candidate) => candidate.id !== item.id),
    item,
  ];
}

function orderMessages(messageIds: readonly string[], messages: readonly HelarcMessage[]): HelarcMessage[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  return messageIds.flatMap((id) => {
    const message = byId.get(id);
    return message ? [message] : [];
  });
}

function appendUnique(items: readonly string[], item: string): string[] {
  return items.includes(item) ? [...items] : [...items, item];
}

function maxIsoDateTime(left: string, right: string): string {
  return right.localeCompare(left) > 0 ? right : left;
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
