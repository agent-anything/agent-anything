import {
  applyHelarcRunProgressCommit,
  applyHelarcRunStartCommit,
  applyHelarcRunTerminalCommit,
  normalizeHelarcThreadAggregate,
  type HelarcCommitResult,
  type HelarcRunProgressCommit,
  type HelarcRunStartCommit,
  type HelarcRunTerminalCommit,
  type HelarcThreadAggregate,
  type HelarcThreadRecord,
  type HelarcWorkContextCommitStore,
} from "@agent-anything/helarc";
import {
  SerializedAtomicFile,
  type AtomicFileTransaction,
  type SerializedAtomicFileOptions,
} from "../persistence/SerializedAtomicFile.js";
import {
  createHelarcThreadSummary,
  type HelarcThreadSummary,
} from "./HelarcThreadSummary.js";

export interface HelarcThreadStoreDocumentV1 {
  readonly formatVersion: 1;
  readonly aggregates: readonly HelarcThreadAggregate[];
}

export interface FileHelarcThreadStoreOptions extends SerializedAtomicFileOptions {
  readonly maxThreads?: number;
}

export interface HelarcThreadStore extends HelarcWorkContextCommitStore {
  listThreadSummaries(): Promise<HelarcThreadSummary[]>;
  loadThread(threadId: string): Promise<HelarcThreadRecord | null>;
}

export class HelarcThreadStoreCorruptionError extends Error {
  readonly code = "thread_store_corrupt";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HelarcThreadStoreCorruptionError";
  }
}

export class FileHelarcThreadStore implements HelarcThreadStore {
  private readonly atomicFile: SerializedAtomicFile;
  private readonly maxThreads: number;

  constructor(
    filePath: string,
    options: FileHelarcThreadStoreOptions = {},
  ) {
    const maxThreads = options.maxThreads ?? 100;
    if (!Number.isSafeInteger(maxThreads) || maxThreads < 1) {
      throw new TypeError("Thread Store maxThreads must be a positive safe integer.");
    }
    this.atomicFile = new SerializedAtomicFile(filePath, options);
    this.maxThreads = maxThreads;
  }

  async listThreadSummaries(): Promise<HelarcThreadSummary[]> {
    return this.atomicFile.transact(async (file) => {
      const document = await this.readDocument(file);
      return sortAggregates(document.aggregates).map((aggregate) =>
        createHelarcThreadSummary(aggregate.record)
      );
    });
  }

  async loadThread(threadId: string): Promise<HelarcThreadRecord | null> {
    const normalizedThreadId = threadId.trim();
    if (normalizedThreadId.length === 0) return null;
    return this.atomicFile.transact(async (file) => {
      const document = await this.readDocument(file);
      return document.aggregates.find(
        (aggregate) => aggregate.record.thread.id === normalizedThreadId,
      )?.record ?? null;
    });
  }

  commitRunStart(input: HelarcRunStartCommit): Promise<HelarcCommitResult> {
    return this.commit(input.threadId, (aggregate) =>
      applyHelarcRunStartCommit(aggregate, input)
    );
  }

  commitRunProgress(input: HelarcRunProgressCommit): Promise<HelarcCommitResult> {
    return this.commit(input.threadId, (aggregate) =>
      applyHelarcRunProgressCommit(aggregate, input)
    );
  }

  commitRunTerminal(input: HelarcRunTerminalCommit): Promise<HelarcCommitResult> {
    return this.commit(input.threadId, (aggregate) =>
      applyHelarcRunTerminalCommit(aggregate, input)
    );
  }

  private async commit(
    threadId: string,
    transition: (
      aggregate: HelarcThreadAggregate | null,
    ) => Promise<HelarcCommitResult>,
  ): Promise<HelarcCommitResult> {
    return this.atomicFile.transact(async (file) => {
      const document = await this.readDocument(file);
      const aggregate = document.aggregates.find(
        (candidate) => candidate.record.thread.id === threadId,
      ) ?? null;
      const result = await transition(aggregate);
      if (result.status !== "applied") return result;

      const merged = [
        result.aggregate,
        ...document.aggregates.filter(
          (candidate) => candidate.record.thread.id !== result.aggregate.record.thread.id,
        ),
      ];
      const retained = retainAggregates(
        merged,
        result.aggregate.record.thread.id,
        this.maxThreads,
      );
      await this.writeDocument(file, { formatVersion: 1, aggregates: retained });
      return result;
    });
  }

  private async readDocument(
    file: AtomicFileTransaction,
  ): Promise<HelarcThreadStoreDocumentV1> {
    const contents = await file.readText();
    if (contents === null) {
      return Object.freeze({ formatVersion: 1, aggregates: Object.freeze([]) });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new HelarcThreadStoreCorruptionError("Thread Store JSON is invalid.", {
        cause: error,
      });
    }
    if (!isStoreDocument(parsed)) {
      throw new HelarcThreadStoreCorruptionError(
        "Thread Store document version or shape is invalid.",
      );
    }

    const aggregates: HelarcThreadAggregate[] = [];
    const threadIds = new Set<string>();
    for (const candidate of parsed.aggregates) {
      const normalized = normalizeHelarcThreadAggregate(candidate as HelarcThreadAggregate);
      if (!normalized.ok) {
        throw new HelarcThreadStoreCorruptionError(normalized.error.message);
      }
      const threadId = normalized.aggregate.record.thread.id;
      if (threadIds.has(threadId)) {
        throw new HelarcThreadStoreCorruptionError(
          `Thread Store contains duplicate Thread identity: ${threadId}.`,
        );
      }
      threadIds.add(threadId);
      aggregates.push(normalized.aggregate);
    }
    return Object.freeze({
      formatVersion: 1,
      aggregates: Object.freeze(aggregates),
    });
  }

  private async writeDocument(
    file: AtomicFileTransaction,
    document: HelarcThreadStoreDocumentV1,
  ): Promise<void> {
    const contents = `${JSON.stringify(document, null, 2)}\n`;
    await file.replaceText(contents);
  }
}

function retainAggregates(
  aggregates: readonly HelarcThreadAggregate[],
  touchedThreadId: string,
  maxThreads: number,
): HelarcThreadAggregate[] {
  const sorted = sortAggregates(aggregates);
  const retained = sorted.slice(0, maxThreads);
  if (retained.some((aggregate) => aggregate.record.thread.id === touchedThreadId)) {
    return retained;
  }
  const touched = sorted.find(
    (aggregate) => aggregate.record.thread.id === touchedThreadId,
  );
  return touched === undefined
    ? retained
    : sortAggregates([...retained.slice(0, -1), touched]);
}

function sortAggregates(
  aggregates: readonly HelarcThreadAggregate[],
): HelarcThreadAggregate[] {
  return [...aggregates].sort((left, right) =>
    Date.parse(right.record.thread.updatedAt) - Date.parse(left.record.thread.updatedAt) ||
    left.record.thread.id.localeCompare(right.record.thread.id)
  );
}

function isStoreDocument(value: unknown): value is {
  readonly formatVersion: 1;
  readonly aggregates: readonly unknown[];
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && record.formatVersion === 1 &&
    Array.isArray(record.aggregates);
}
