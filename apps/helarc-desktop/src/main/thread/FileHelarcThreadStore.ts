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
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createHelarcThreadSummary,
  type HelarcThreadSummary,
} from "./HelarcThreadSummary.js";

export interface HelarcThreadStoreDocumentV1 {
  readonly formatVersion: 1;
  readonly aggregates: readonly HelarcThreadAggregate[];
}

export interface HelarcAtomicWriteOperations {
  mkdir(path: string): Promise<void>;
  writeExclusive(path: string, contents: string): Promise<void>;
  syncFile(path: string): Promise<void>;
  rename(sourcePath: string, targetPath: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface FileHelarcThreadStoreOptions {
  readonly maxThreads?: number;
  readonly atomicWriteOperations?: Partial<HelarcAtomicWriteOperations>;
  readonly createTemporaryId?: () => string;
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

const operationQueues = new Map<string, Promise<void>>();

const nodeAtomicWriteOperations: HelarcAtomicWriteOperations = Object.freeze({
  async mkdir(path: string) {
    await mkdir(path, { recursive: true });
  },
  async writeExclusive(path: string, contents: string) {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  },
  async syncFile(path: string) {
    const handle = await open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async rename(sourcePath: string, targetPath: string) {
    await rename(sourcePath, targetPath);
  },
  async remove(path: string) {
    await unlink(path);
  },
});

export class FileHelarcThreadStore implements HelarcThreadStore {
  private readonly canonicalFilePath: string;
  private readonly operationQueueKey: string;
  private readonly maxThreads: number;
  private readonly atomicWriteOperations: HelarcAtomicWriteOperations;
  private readonly createTemporaryId: () => string;

  constructor(
    filePath: string,
    options: FileHelarcThreadStoreOptions = {},
  ) {
    if (filePath.trim().length === 0) {
      throw new TypeError("Thread Store file path is required.");
    }
    const maxThreads = options.maxThreads ?? 100;
    if (!Number.isSafeInteger(maxThreads) || maxThreads < 1) {
      throw new TypeError("Thread Store maxThreads must be a positive safe integer.");
    }
    this.canonicalFilePath = resolve(filePath);
    this.operationQueueKey = process.platform === "win32"
      ? this.canonicalFilePath.toLowerCase()
      : this.canonicalFilePath;
    this.maxThreads = maxThreads;
    this.atomicWriteOperations = Object.freeze({
      ...nodeAtomicWriteOperations,
      ...options.atomicWriteOperations,
    });
    this.createTemporaryId = options.createTemporaryId ?? randomUUID;
  }

  async listThreadSummaries(): Promise<HelarcThreadSummary[]> {
    return serializeFileOperation(this.operationQueueKey, async () => {
      const document = await this.readDocument();
      return sortAggregates(document.aggregates).map((aggregate) =>
        createHelarcThreadSummary(aggregate.record)
      );
    });
  }

  async loadThread(threadId: string): Promise<HelarcThreadRecord | null> {
    const normalizedThreadId = threadId.trim();
    if (normalizedThreadId.length === 0) return null;
    return serializeFileOperation(this.operationQueueKey, async () => {
      const document = await this.readDocument();
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
    return serializeFileOperation(this.operationQueueKey, async () => {
      const document = await this.readDocument();
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
      await this.writeDocument({ formatVersion: 1, aggregates: retained });
      return result;
    });
  }

  private async readDocument(): Promise<HelarcThreadStoreDocumentV1> {
    let contents: string;
    try {
      contents = await readFile(this.canonicalFilePath, "utf8");
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        return Object.freeze({ formatVersion: 1, aggregates: Object.freeze([]) });
      }
      throw error;
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

  private async writeDocument(document: HelarcThreadStoreDocumentV1): Promise<void> {
    const contents = `${JSON.stringify(document, null, 2)}\n`;
    const temporaryId = this.createTemporaryId();
    if (!/^[A-Za-z0-9_-]+$/.test(temporaryId)) {
      throw new TypeError("Thread Store temporary file identity is invalid.");
    }
    const temporaryPath = `${this.canonicalFilePath}.tmp-${process.pid}-${temporaryId}`;
    const directoryPath = dirname(this.canonicalFilePath);
    let temporaryCreated = false;
    try {
      await this.atomicWriteOperations.mkdir(directoryPath);
      try {
        await this.atomicWriteOperations.writeExclusive(temporaryPath, contents);
        temporaryCreated = true;
      } catch (error) {
        temporaryCreated = !isFileSystemError(error, "EEXIST");
        throw error;
      }
      await this.atomicWriteOperations.syncFile(temporaryPath);
      await this.atomicWriteOperations.rename(temporaryPath, this.canonicalFilePath);
      temporaryCreated = false;
    } finally {
      if (temporaryCreated) {
        try {
          await this.atomicWriteOperations.remove(temporaryPath);
        } catch {
          // The target remains authoritative; stale temporary files are never read.
        }
      }
    }
  }
}

function serializeFileOperation<T>(
  canonicalFilePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = operationQueues.get(canonicalFilePath) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const settled = result.then(() => undefined, () => undefined);
  operationQueues.set(canonicalFilePath, settled);
  return result.finally(() => {
    if (operationQueues.get(canonicalFilePath) === settled) {
      operationQueues.delete(canonicalFilePath);
    }
  });
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

function isFileSystemError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" &&
    (error as { code?: unknown }).code === code;
}
