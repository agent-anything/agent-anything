import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
} from "@agent-anything/shared";
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
      stdout: "done",
    });
    expect(terminations).toEqual([]);
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
