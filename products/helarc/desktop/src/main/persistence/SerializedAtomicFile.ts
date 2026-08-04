import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface AtomicFileOperations {
  readText(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  writeExclusive(path: string, contents: string): Promise<void>;
  syncFile(path: string): Promise<void>;
  replace(sourcePath: string, targetPath: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface SerializedAtomicFileOptions {
  readonly operations?: Partial<AtomicFileOperations>;
  readonly createTemporaryId?: () => string;
}

export interface AtomicFileTransaction {
  readText(): Promise<string | null>;
  replaceText(contents: string): Promise<void>;
  remove(): Promise<void>;
}

const operationQueues = new Map<string, Promise<void>>();

const nodeAtomicFileOperations: AtomicFileOperations = Object.freeze({
  async readText(path: string) {
    return readFile(path, "utf8");
  },
  async mkdir(path: string) {
    await mkdir(path, { recursive: true });
  },
  async writeExclusive(path: string, contents: string) {
    await writeFile(path, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  },
  async syncFile(path: string) {
    const handle = await open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async replace(sourcePath: string, targetPath: string) {
    await rename(sourcePath, targetPath);
  },
  async remove(path: string) {
    await unlink(path);
  },
});

export class SerializedAtomicFile {
  readonly filePath: string;

  private readonly operationQueueKey: string;
  private readonly operations: AtomicFileOperations;
  private readonly createTemporaryId: () => string;

  constructor(
    filePath: string,
    options: SerializedAtomicFileOptions = {},
  ) {
    if (filePath.trim().length === 0) {
      throw new TypeError("Atomic file path is required.");
    }
    this.filePath = resolve(filePath);
    this.operationQueueKey = process.platform === "win32"
      ? this.filePath.toLowerCase()
      : this.filePath;
    this.operations = Object.freeze({
      ...nodeAtomicFileOperations,
      ...options.operations,
    });
    this.createTemporaryId = options.createTemporaryId ?? randomUUID;
  }

  transact<T>(
    operation: (file: AtomicFileTransaction) => Promise<T>,
  ): Promise<T> {
    return serializeFileOperation(this.operationQueueKey, () =>
      operation({
        readText: () => this.readText(),
        replaceText: (contents) => this.replaceText(contents),
        remove: () => this.remove(),
      })
    );
  }

  private async readText(): Promise<string | null> {
    try {
      return await this.operations.readText(this.filePath);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
  }

  private async replaceText(contents: string): Promise<void> {
    const temporaryId = this.createTemporaryId();
    if (!/^[A-Za-z0-9_-]+$/.test(temporaryId)) {
      throw new TypeError("Atomic file temporary identity is invalid.");
    }

    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${temporaryId}`;
    let temporaryCreated = false;
    try {
      await this.operations.mkdir(dirname(this.filePath));
      try {
        await this.operations.writeExclusive(temporaryPath, contents);
        temporaryCreated = true;
      } catch (error) {
        temporaryCreated = !isFileSystemError(error, "EEXIST");
        throw error;
      }
      await this.operations.syncFile(temporaryPath);
      await this.operations.replace(temporaryPath, this.filePath);
      temporaryCreated = false;
    } finally {
      if (temporaryCreated) {
        try {
          await this.operations.remove(temporaryPath);
        } catch {
          // The target remains authoritative; stale temporary files are ignored.
        }
      }
    }
  }

  private async remove(): Promise<void> {
    try {
      await this.operations.remove(this.filePath);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) {
        throw error;
      }
    }
  }
}

function serializeFileOperation<T>(
  queueKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = operationQueues.get(queueKey) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const settled = result.then(() => undefined, () => undefined);
  operationQueues.set(queueKey, settled);
  return result.finally(() => {
    if (operationQueues.get(queueKey) === settled) {
      operationQueues.delete(queueKey);
    }
  });
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" &&
    (error as { code?: unknown }).code === code;
}
