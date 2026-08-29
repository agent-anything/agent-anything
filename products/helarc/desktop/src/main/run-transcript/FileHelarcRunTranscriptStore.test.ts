import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTranscriptRecord } from "@agent-anything/agent-runtime/transcript";
import { FileHelarcRunTranscriptStore } from "./FileHelarcRunTranscriptStore.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("FileHelarcRunTranscriptStore", () => {
  it("stores the exact private Transcript as ordered JSON Lines", async () => {
    const directory = await temporaryDirectory();
    const store = new FileHelarcRunTranscriptStore(directory);
    const first = record(1, {
      kind: "controller_turn",
      privateModelMaterial: { prompt: "private instruction material" },
    });
    const second = record(2, {
      kind: "terminal_transition",
      status: "succeeded",
      code: null,
    });

    await expect(store.append(first)).resolves.toEqual({ status: "stored" });
    await expect(store.append(second)).resolves.toEqual({ status: "stored" });

    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.jsonl$/u);
    const lines = (await readFile(join(directory, files[0]!), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([first, second]);
    expect(lines[0].item.payload.privateModelMaterial.prompt)
      .toBe("private instruction material");
  });

  it("rejects gaps without persisting an ambiguous sequence", async () => {
    const directory = await temporaryDirectory();
    const store = new FileHelarcRunTranscriptStore(directory);

    await expect(store.append(record(2, { kind: "terminal_transition" })))
      .resolves.toMatchObject({
        status: "failed",
        code: "run_transcript_sequence_invalid",
      });
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function record(sequence: number, payload: Record<string, unknown>): RunTranscriptRecord {
  return {
    runId: "run-private-1",
    sequence,
    item: {
      ref: {
        run: { id: "run-private-1" },
        id: `run-private-1:item:${sequence}`,
        sequence,
      },
      committedInRevision: sequence,
      createdAt: "2026-08-29T00:00:00.000Z",
      payload: payload as never,
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "helarc-run-transcript-"));
  temporaryDirectories.push(directory);
  await rm(directory, { recursive: true, force: true });
  return directory;
}
