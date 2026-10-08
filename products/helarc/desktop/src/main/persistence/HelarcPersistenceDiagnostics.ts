import { SerializedAtomicFile } from "./SerializedAtomicFile.js";

export interface HelarcPersistenceFailure {
  readonly operation: "run_projection" | "run_terminal";
  readonly threadId: string;
  readonly runId: string;
  readonly projectionSequence: number;
  readonly expectedRevision: number;
  readonly occurredAt: string;
  readonly code: string;
}

export class HelarcPersistenceDiagnostics {
  private readonly file: SerializedAtomicFile;
  constructor(path: string) { this.file = new SerializedAtomicFile(path); }

  async record(failure: HelarcPersistenceFailure): Promise<void> {
    await this.file.transact(async file => {
      const text = await file.readText();
      if ((text?.length ?? 0) > 128_000) throw new Error("persistence_diagnostics_invalid");
      const previous = text === null ? [] : JSON.parse(text) as unknown;
      if (!Array.isArray(previous) || previous.length > 100) {
        throw new Error("persistence_diagnostics_invalid");
      }
      await file.replaceText(JSON.stringify([...previous.slice(-99), failure]));
    });
  }
}

export function persistenceFailureCode(cause: unknown): string {
  const code = cause !== null && typeof cause === "object" && "code" in cause ? cause.code : null;
  return typeof code === "string" && ["EACCES", "EPERM", "ENOSPC", "EIO", "EBUSY", "ENOENT", "EMFILE", "ENFILE", "thread_store_corrupt"].includes(code)
    ? code : "persistence_write_failed";
}
