import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  RunTranscriptAppendResult,
  RunTranscriptPort,
  RunTranscriptRecord,
} from "@agent-anything/agent-runtime/transcript";

export class FileHelarcRunTranscriptStore implements RunTranscriptPort {
  private tail: Promise<void> = Promise.resolve();
  private readonly lastSequenceByRun = new Map<string, number>();

  constructor(private readonly directory: string) {}

  append(record: RunTranscriptRecord): Promise<RunTranscriptAppendResult> {
    const operation = this.tail.then(async (): Promise<RunTranscriptAppendResult> => {
      const previous = this.lastSequenceByRun.get(record.runId) ?? 0;
      if (record.sequence !== previous + 1) {
        return Object.freeze({
          status: "failed" as const,
          code: "run_transcript_sequence_invalid",
          message: "Run Transcript records must be appended in exact Run-local order.",
        });
      }
      try {
        await mkdir(this.directory, { recursive: true });
        await appendFile(
          join(this.directory, `${fileToken(record.runId)}.jsonl`),
          `${JSON.stringify(record)}\n`,
          { encoding: "utf8" },
        );
        this.lastSequenceByRun.set(record.runId, record.sequence);
        return Object.freeze({ status: "stored" as const });
      } catch {
        return Object.freeze({
          status: "failed" as const,
          code: "run_transcript_append_failed",
          message: "The private Run Transcript record could not be stored.",
        });
      }
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

function fileToken(runId: string): string {
  return createHash("sha256").update(runId).digest("hex");
}
