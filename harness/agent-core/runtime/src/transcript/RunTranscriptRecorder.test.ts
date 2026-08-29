import { describe, expect, it } from "vitest";
import type { RunItem } from "../run/index.js";
import type { RunTranscriptRecord } from "./RunTranscript.js";
import { RunTranscriptRecorder } from "./RunTranscriptRecorder.js";

describe("RunTranscriptRecorder", () => {
  it("appends each exact RunItem once in Run-local sequence order", async () => {
    const records: RunTranscriptRecord[] = [];
    const recorder = new RunTranscriptRecorder({
      async append(record) {
        records.push(record);
        return { status: "stored" };
      },
    });
    const first = item(1, "controller_turn");
    const second = item(2, "stop_review");

    recorder.record([first]);
    recorder.record([first, second]);
    await expect(recorder.flush()).resolves.toEqual([]);

    expect(records.map(({ sequence }) => sequence)).toEqual([1, 2]);
    expect(records.map(({ item: recorded }) => recorded)).toEqual([first, second]);
    expect(Object.isFrozen(records[0])).toBe(true);
    expect(Object.isFrozen(records[0]?.item)).toBe(true);
  });

  it("reports storage failures without making the diagnostic port authoritative", async () => {
    const recorder = new RunTranscriptRecorder({
      async append() {
        return {
          status: "failed",
          code: "transcript_unavailable",
          message: "Transcript storage is unavailable.",
        };
      },
    });

    recorder.record([item(1, "terminal_transition")]);

    await expect(recorder.flush()).resolves.toEqual(["transcript_unavailable"]);
  });
});

function item(sequence: number, kind: string): RunItem {
  return {
    ref: { run: { id: "run-1" }, id: `item-${sequence}`, sequence },
    committedInRevision: sequence,
    createdAt: "2026-08-29T00:00:00.000Z",
    payload: { kind } as never,
  };
}
