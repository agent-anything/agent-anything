import { SerializedAtomicFile } from "../persistence/SerializedAtomicFile.js";
import { captureExecutionError, diagnosticText } from "./ExecutionErrorDetails.js";

export type ExecutionDiagnosticContext = Readonly<Record<string, string | number | boolean | null>>;
export interface ExecutionDiagnosticSink {
  record(stage: string, context: ExecutionDiagnosticContext, error: unknown): void;
}

export function reportExecutionFailure(sink: ExecutionDiagnosticSink | undefined, stage: string, context: ExecutionDiagnosticContext, error: unknown): void {
  try { sink?.record(stage, context, error); } catch { /* Diagnostics cannot change execution. */ }
}

/** Local bounded diagnostics, independent of authoritative execution storage. */
export class HelarcExecutionDiagnostics implements ExecutionDiagnosticSink {
  private readonly file: SerializedAtomicFile;
  private pending = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(path: string) { this.file = new SerializedAtomicFile(path); }

  record(stage: string, context: ExecutionDiagnosticContext, error: unknown): void {
    try {
      const record = {occurredAt: new Date().toISOString(), processId: process.pid, stage: diagnosticText(stage, 256),
        context: Object.fromEntries(Object.entries(context).slice(0, 32).map(([key, value]) =>
          [key, typeof value === "string" ? diagnosticText(value, 1024) : value])), error: captureExecutionError(error)};
      console.error("Helarc execution diagnostic:", JSON.stringify(record));
      if (this.pending >= 16) { console.error("Helarc execution diagnostic queue is full; record was logged to stderr only."); return; }
      this.pending++;
      this.tail = this.file.transact(async file => {
        const text = await file.readText();
        if (text !== null && Buffer.byteLength(text) > 512 * 1024) throw new Error("execution_diagnostics_too_large");
        const previous: unknown = text === null ? [] : JSON.parse(text);
        if (!Array.isArray(previous)) throw new Error("execution_diagnostics_invalid");
        const records = [...previous.slice(-31), record];
        while (records.length > 1 && Buffer.byteLength(JSON.stringify(records, null, 2)) > 512 * 1024) records.shift();
        if (Buffer.byteLength(JSON.stringify(records, null, 2)) > 512 * 1024) throw new Error("execution_diagnostic_record_too_large");
        await file.replaceText(JSON.stringify(records, null, 2));
      }).catch(() => {
        try { console.error("Helarc execution diagnostic could not be saved."); } catch { /* Best effort only. */ }
      })
        .finally(() => {this.pending--;});
    } catch { /* Do not obscure the original exception. */ }
  }

  async flush(): Promise<void> { await this.tail; }
}
