import {
  snapshotModelContinuationRef,
  type ModelContinuationRef,
  type ModelContinuationStore,
  type ModelContinuationStoreCommitResult,
} from "@agent-anything/model-interaction/continuation";
import {
  SerializedAtomicFile,
  type AtomicFileTransaction,
  type SerializedAtomicFileOptions,
} from "../persistence/SerializedAtomicFile.js";

export interface HelarcModelContinuationStoreDocumentV1 {
  readonly formatVersion: 1;
  readonly records: readonly ModelContinuationRef[];
}

export interface FileHelarcModelContinuationStoreOptions
  extends SerializedAtomicFileOptions {
  readonly maxBranches?: number;
}

export class HelarcModelContinuationStoreCorruptionError extends Error {
  readonly code = "model_continuation_store_corrupt";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HelarcModelContinuationStoreCorruptionError";
  }
}

export class FileHelarcModelContinuationStore
  implements ModelContinuationStore {
  private readonly atomicFile: SerializedAtomicFile;
  private readonly maxBranches: number;

  constructor(
    filePath: string,
    options: FileHelarcModelContinuationStoreOptions = {},
  ) {
    const maxBranches = options.maxBranches ?? 200;
    if (!Number.isSafeInteger(maxBranches) || maxBranches < 1) {
      throw new TypeError(
        "Model Continuation Store maxBranches must be a positive safe integer.",
      );
    }
    this.atomicFile = new SerializedAtomicFile(filePath, options);
    this.maxBranches = maxBranches;
  }

  async listContinuations(): Promise<readonly ModelContinuationRef[]> {
    return this.atomicFile.transact(async (file) =>
      (await this.readDocument(file)).records
    );
  }

  async load(branchId: string): Promise<ModelContinuationRef | null> {
    const normalizedBranchId = requiredToken(branchId, "branchId");
    return this.atomicFile.transact(async (file) =>
      (await this.readDocument(file)).records.find(
        (record) => record.branchId === normalizedBranchId,
      ) ?? null
    );
  }

  commit(input: {
    readonly branchId: string;
    readonly expectedContinuationId: string | null;
    readonly continuation: ModelContinuationRef;
  }): Promise<ModelContinuationStoreCommitResult> {
    const branchId = requiredToken(input.branchId, "branchId");
    const continuation = snapshotModelContinuationRef(input.continuation);
    if (continuation.branchId !== branchId) {
      throw new TypeError(
        "Model Continuation branch does not match its Store branch.",
      );
    }
    return this.atomicFile.transact(async (file) => {
      const document = await this.readDocument(file);
      const current = document.records.find(
        (record) => record.branchId === branchId,
      ) ?? null;
      if ((current?.id ?? null) !== input.expectedContinuationId) {
        return Object.freeze({ kind: "conflict" as const });
      }
      const records = [
        continuation,
        ...document.records.filter((record) => record.branchId !== branchId),
      ].slice(0, this.maxBranches);
      await this.writeDocument(file, records);
      return Object.freeze({ kind: "committed" as const });
    });
  }

  clear(input: {
    readonly branchId: string;
    readonly expectedContinuationId: string;
  }): Promise<ModelContinuationStoreCommitResult> {
    const branchId = requiredToken(input.branchId, "branchId");
    const expectedContinuationId = requiredToken(
      input.expectedContinuationId,
      "expectedContinuationId",
    );
    return this.atomicFile.transact(async (file) => {
      const document = await this.readDocument(file);
      const current = document.records.find(
        (record) => record.branchId === branchId,
      ) ?? null;
      if (current?.id !== expectedContinuationId) {
        return Object.freeze({ kind: "conflict" as const });
      }
      await this.writeDocument(
        file,
        document.records.filter((record) => record.branchId !== branchId),
      );
      return Object.freeze({ kind: "committed" as const });
    });
  }

  private async readDocument(
    file: AtomicFileTransaction,
  ): Promise<HelarcModelContinuationStoreDocumentV1> {
    const contents = await file.readText();
    if (contents === null) {
      return Object.freeze({ formatVersion: 1, records: Object.freeze([]) });
    }
    try {
      const parsed: unknown = JSON.parse(contents);
      if (!isDocument(parsed)) {
        throw new TypeError("Document version or shape is invalid.");
      }
      const records = parsed.records.map((record) =>
        snapshotModelContinuationRef(record as ModelContinuationRef)
      );
      if (new Set(records.map((record) => record.branchId)).size !== records.length) {
        throw new TypeError("Document contains duplicate branch identities.");
      }
      return Object.freeze({
        formatVersion: 1,
        records: Object.freeze(records),
      });
    } catch (cause) {
      throw new HelarcModelContinuationStoreCorruptionError(
        "Model Continuation Store document version or shape is invalid.",
        { cause },
      );
    }
  }

  private writeDocument(
    file: AtomicFileTransaction,
    records: readonly ModelContinuationRef[],
  ): Promise<void> {
    return file.replaceText(`${JSON.stringify({
      formatVersion: 1,
      records,
    }, null, 2)}\n`);
  }
}

function isDocument(
  input: unknown,
): input is { readonly formatVersion: 1; readonly records: readonly unknown[] } {
  return input !== null && typeof input === "object" && !Array.isArray(input) &&
    Object.keys(input).length === 2 &&
    Object.keys(input).every((key) => key === "formatVersion" || key === "records") &&
    (input as { formatVersion?: unknown }).formatVersion === 1 &&
    Array.isArray((input as { records?: unknown }).records);
}

function requiredToken(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return value;
}
