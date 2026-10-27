import { SerializedAtomicFile, type AtomicFileWriteReport } from "./SerializedAtomicFile.js";
import type { ExecutionErrorDetails } from "../diagnostics/ExecutionErrorDetails.js";

export interface HelarcPersistenceDiagnostic {
  readonly operation: "run_start" | "run_projection" | "run_terminal";
  readonly threadId: string;
  readonly runId: string;
  readonly projectionSequence: number;
  readonly expectedRevision: number;
  readonly occurredAt: string;
  readonly code: string;
  readonly outcome?: "failed" | "recovered" | "replacement_recovered";
  readonly commitId?: string;
  readonly attempt?: number;
  readonly firstFailedSequence?: number;
  readonly error?: ExecutionErrorDetails;
  readonly writeReport?: AtomicFileWriteReport;
}

export class HelarcPersistenceDiagnostics {
  private readonly file: SerializedAtomicFile;
  constructor(path: string) { this.file = new SerializedAtomicFile(path); }

  async record(diagnostic: HelarcPersistenceDiagnostic): Promise<void> {
    await this.file.transact(async file => {
      const text = await file.readText();
      if ((text?.length ?? 0) > 128_000) throw new Error("persistence_diagnostics_invalid");
      const previous = text === null ? [] : JSON.parse(text) as unknown;
      if (!Array.isArray(previous) || previous.length > 100) {
        throw new Error("persistence_diagnostics_invalid");
      }
      const entries = [...previous.slice(-99), diagnostic];
      while (JSON.stringify(entries).length > 128_000 && entries.length > 1) entries.shift();
      if (JSON.stringify(entries).length > 128_000) throw new Error("persistence_diagnostic_too_large");
      await file.replaceText(JSON.stringify(entries));
    });
  }
}

export function persistenceFailureCode(cause: unknown): string {
  const code = cause !== null && typeof cause === "object" && "code" in cause ? cause.code : null;
  return typeof code === "string" && ["EACCES", "EPERM", "ENOSPC", "EIO", "EBUSY", "ENOENT", "EMFILE", "ENFILE", "thread_store_corrupt"].includes(code)
    ? code : "persistence_write_failed";
}
