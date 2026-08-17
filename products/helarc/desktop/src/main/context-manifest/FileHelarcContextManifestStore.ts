import type {
  ContextManifestPersistencePort,
  ContextManifestPersistenceResult,
} from "@agent-anything/context/persistence";
import {
  snapshotSafeProjectionManifest,
  type SafeProjectionManifest,
} from "@agent-anything/context/projection";
import {
  SerializedAtomicFile,
  type AtomicFileTransaction,
  type SerializedAtomicFileOptions,
} from "../persistence/SerializedAtomicFile.js";

export interface HelarcContextManifestStoreDocumentV1 {
  readonly formatVersion: 1;
  readonly records: readonly SafeProjectionManifest[];
}

export interface FileHelarcContextManifestStoreOptions
  extends SerializedAtomicFileOptions {
  readonly maxRecords?: number;
}

export class HelarcContextManifestStoreCorruptionError extends Error {
  readonly code = "context_manifest_store_corrupt";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HelarcContextManifestStoreCorruptionError";
  }
}

export class FileHelarcContextManifestStore
  implements ContextManifestPersistencePort {
  private readonly atomicFile: SerializedAtomicFile;
  private readonly maxRecords: number;

  constructor(
    filePath: string,
    options: FileHelarcContextManifestStoreOptions = {},
  ) {
    const maxRecords = options.maxRecords ?? 500;
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
      throw new TypeError(
        "Context Manifest Store maxRecords must be a positive safe integer.",
      );
    }
    this.atomicFile = new SerializedAtomicFile(filePath, options);
    this.maxRecords = maxRecords;
  }

  async listManifests(): Promise<readonly SafeProjectionManifest[]> {
    return this.atomicFile.transact(async (file) =>
      (await this.readDocument(file)).records
    );
  }

  async persistManifest(
    candidate: SafeProjectionManifest,
  ): Promise<ContextManifestPersistenceResult> {
    const manifest = snapshotSafeProjectionManifest(candidate);
    try {
      return await this.atomicFile.transact(async (file) => {
        const document = await this.readDocument(file);
        const records = [
          manifest,
          ...document.records.filter(
            (record) => record.manifestId !== manifest.manifestId,
          ),
        ].slice(0, this.maxRecords);
        await file.replaceText(`${JSON.stringify({
          formatVersion: 1,
          records,
        }, null, 2)}\n`);
        return Object.freeze({
          kind: "stored" as const,
          recordId: manifest.manifestId,
        });
      });
    } catch (cause) {
      if (cause instanceof HelarcContextManifestStoreCorruptionError) {
        throw cause;
      }
      return Object.freeze({
        kind: "failed" as const,
        code: "context_manifest_store_write_failed",
        message: "Context Projection Manifest could not be persisted.",
      });
    }
  }

  private async readDocument(
    file: AtomicFileTransaction,
  ): Promise<HelarcContextManifestStoreDocumentV1> {
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
        snapshotSafeProjectionManifest(record as SafeProjectionManifest)
      );
      if (new Set(records.map((record) => record.manifestId)).size !== records.length) {
        throw new TypeError("Document contains duplicate Manifest identities.");
      }
      return Object.freeze({
        formatVersion: 1,
        records: Object.freeze(records),
      });
    } catch (cause) {
      throw new HelarcContextManifestStoreCorruptionError(
        "Context Manifest Store document version or shape is invalid.",
        { cause },
      );
    }
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
