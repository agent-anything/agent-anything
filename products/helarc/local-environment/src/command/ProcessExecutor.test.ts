import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { InvocationInterruptionContext, InvocationInterruptionRef } from "@agent-anything/agent-core/control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeProcess } from "./ProcessExecutor.js";

describe("executeProcess", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not confirm cancellation until the process closes", async () => {
    const child = createChildProcess();
    const cancellation = createInterruptionContext();
    const terminations: boolean[] = [];
    let settled = false;
    const pending = executeProcess(
      createInput(cancellation.context),
      {
        spawnProcess: () => child,
        terminateProcessTree: (_child, force) => terminations.push(force),
      },
    );
    void pending.then(() => { settled = true; });

    cancellation.abort({
      kind: "run_cancellation",
      cancellation: { runId: "run-001", requestId: "cancel-001" },
    });
    await Promise.resolve();

    expect(terminations).toEqual([false]);
    expect(settled).toBe(false);

    child.emit("close", null, "SIGTERM");
    await expect(pending).resolves.toMatchObject({
      kind: "cancelled",
      signal: "SIGTERM",
      termination: "graceful",
    });
  });

  it("escalates and reports unconfirmed cancellation when close never arrives", async () => {
    vi.useFakeTimers();
    const child = createChildProcess();
    const cancellation = createInterruptionContext();
    const terminations: boolean[] = [];
    const pending = executeProcess(
      createInput(cancellation.context),
      {
        spawnProcess: () => child,
        terminateProcessTree: (_child, force) => terminations.push(force),
      },
    );

    cancellation.abort({
      kind: "run_cancellation",
      cancellation: { runId: "run-001", requestId: "cancel-002" },
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(terminations).toEqual([false, true]);

    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).resolves.toMatchObject({
      kind: "cancellation_unconfirmed",
    });
  });

  it("keeps a completion that settles before cancellation", async () => {
    const child = createChildProcess();
    const cancellation = createInterruptionContext();
    const terminations: boolean[] = [];
    const pending = executeProcess(
      createInput(cancellation.context),
      {
        spawnProcess: () => child,
        terminateProcessTree: (_child, force) => terminations.push(force),
      },
    );

    child.stdout?.write("done");
    child.emit("close", 0, null);
    cancellation.abort({
      kind: "run_cancellation",
      cancellation: { runId: "run-001", requestId: "cancel-late" },
    });

    await expect(pending).resolves.toMatchObject({
      kind: "completed",
      exitCode: 0,
      stdout: {
        text: "done",
        integrity: "exact",
        encodingSource: "utf8",
      },
    });
    expect(terminations).toEqual([]);
  });

  it("distinguishes failed process start from unknown post-spawn settlement", async () => {
    const cancellation = createInterruptionContext();

    await expect(executeProcess(
      createInput(cancellation.context),
      {
        spawnProcess() {
          throw new Error("spawn failed");
        },
      },
    )).resolves.toEqual({
      kind: "failed",
      effectState: "none",
    });

    const child = createChildProcess();
    const pending = executeProcess(
      createInput(cancellation.context),
      { spawnProcess: () => child },
    );
    child.emit("error", new Error("process failed after spawn"));

    await expect(pending).resolves.toEqual({
      kind: "failed",
      effectState: "unknown",
    });
  });

  it("does not materialize a foreground output file when bounded output is complete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-foreground-output-"));
    const outputPath = join(directory, "output.log");
    try {
      const child = createChildProcess();
      const cancellation = createInterruptionContext();
      const pending = executeProcess({
        ...createInput(cancellation.context),
        outputFile: {
          absolutePath: outputPath,
          relativePath: "output.log",
          maximumBytes: 1_024,
        },
      }, { spawnProcess: () => child });

      child.stdout?.write("done");
      child.emit("close", 0, null);

      await expect(pending).resolves.toMatchObject({
        kind: "completed",
        stdout: {
          text: "done",
          integrity: "exact",
        },
        stdoutTruncated: false,
        outputFile: null,
      });
      await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("materializes declared foreground overflow only after direct output truncates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-foreground-overflow-"));
    const outputPath = join(directory, "output.log");
    try {
      const child = createChildProcess();
      const cancellation = createInterruptionContext();
      const pending = executeProcess({
        ...createInput(cancellation.context),
        maxStdoutBytes: 4,
        outputFile: {
          absolutePath: outputPath,
          relativePath: "output.log",
          maximumBytes: 1_024,
        },
      }, { spawnProcess: () => child });

      child.stdout?.write("abcdef");
      child.emit("close", 0, null);

      await expect(pending).resolves.toMatchObject({
        kind: "completed",
        stdout: {
          text: "abcd",
          integrity: "exact",
        },
        stdoutTruncated: true,
        outputFile: "output.log",
      });
      await expect(readFile(outputPath, "utf8")).resolves.toBe("[stdout] abcdef");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps process completion separate from inferred text decoding", async () => {
    const child = createChildProcess();
    const cancellation = createInterruptionContext();
    const pending = executeProcess(
      createInput(cancellation.context),
      { spawnProcess: () => child },
    );

    child.stderr?.write(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]));
    child.emit("close", 0, null);

    await expect(pending).resolves.toMatchObject({
      kind: "completed",
      exitCode: 0,
      stderr: {
        text: "\u041f\u0440\u0438\u0432\u0435\u0442",
        integrity: "inferred",
        encodingSource: "detected",
      },
    });
  });
});

function createChildProcess(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, {
    pid: 1234,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return child;
}

function createInterruptionContext(): {
  context: InvocationInterruptionContext;
  abort(interruption: InvocationInterruptionRef): void;
} {
  const controller = new AbortController();
  let interruption: InvocationInterruptionRef | null = null;
  return {
    context: {
      signal: controller.signal,
      get interruption() {
        return interruption;
      },
    },
    abort(next) {
      interruption = next;
      controller.abort(new Error("cancelled"));
    },
  };
}

function createInput(interruption: InvocationInterruptionContext) {
  return {
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 5000)"],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    maxStdoutBytes: 100,
    maxStderrBytes: 100,
    interruption,
    termination: {
      gracePeriodMs: 20,
      forceKillTimeoutMs: 30,
    },
    startedMs: 0,
    nowMs: () => 100,
  };
}
