import { createHash } from "node:crypto";
import { join } from "node:path";
import { SerializedAtomicFile } from "../persistence/SerializedAtomicFile.js";
import { canonicalEncode } from "@agent-anything/canonical-action/subject";
import type {
  RunTranscriptAppendResult,
  RunTranscriptPort,
  RunTranscriptRecord,
} from "@agent-anything/agent-runtime/transcript";

export class FileHelarcRunTranscriptStore implements RunTranscriptPort {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  append(record: RunTranscriptRecord): Promise<RunTranscriptAppendResult> {
    const operation = this.tail.then(async (): Promise<RunTranscriptAppendResult> => {
      try {
        return await new SerializedAtomicFile(join(this.directory, `${fileToken(record.runId)}.jsonl`)).transact(async file => {
          const text = await file.readText() ?? "";
          const records = text.split("\n").filter(line => line.length > 0).map(line => JSON.parse(line) as RunTranscriptRecord);
          if (records.some((item, index) => item.runId !== record.runId || item.sequence !== index + 1)) throw new Error("Transcript prefix is invalid.");
          const previous = records[record.sequence - 1];
          if (previous) {
            const a = canonicalEncode("transcript.v1", previous), b = canonicalEncode("transcript.v1", record);
            if (a.length !== b.length || a.some((byte, index) => byte !== b[index])) throw new Error("Transcript replay conflicts.");
            return {status: "stored" as const};
          }
          if (record.sequence !== records.length + 1) return {status: "failed" as const,
            code: "run_transcript_sequence_invalid", message: "Run Transcript records must be appended in exact Run-local order."};
          await file.replaceText(`${text}${JSON.stringify(record)}\n`);
          return {status: "stored" as const};
        });
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
