import {
  createRunTranscriptRecord,
  type RunTranscriptPort,
} from "./RunTranscript.js";
import type { RunItem } from "../run/index.js";

export class RunTranscriptRecorder {
  private tail: Promise<void> = Promise.resolve();
  private lastSequence = 0;
  private failures: string[] = [];

  constructor(private readonly port: RunTranscriptPort | null) {}

  record<TOutput>(items: readonly RunItem<TOutput>[]): void {
    if (this.port === null) return;
    for (const item of items) {
      if (item.ref.sequence <= this.lastSequence) continue;
      this.lastSequence = item.ref.sequence;
      const record = createRunTranscriptRecord(item);
      this.tail = this.tail.then(async () => {
        try {
          const result = await this.port!.append(record);
          if (result.status === "failed") this.failures.push(result.code);
        } catch {
          this.failures.push("run_transcript_append_failed");
        }
      });
    }
  }

  async flush(): Promise<readonly string[]> {
    await this.tail;
    return Object.freeze([...this.failures]);
  }
}

