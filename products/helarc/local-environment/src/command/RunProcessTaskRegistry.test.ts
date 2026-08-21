import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { RunProcessTaskRegistry } from "./RunProcessTaskRegistry.js";

describe("RunProcessTaskRegistry", () => {
  it("starts, attributes, captures, and stops one exact background task", async () => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-process-task-"));
    const outputPath = join(directory, "task.log");
    const child = fakeChild(4242);
    const registry = new RunProcessTaskRegistry(2, 4, {
      spawnProcess: () => child,
      terminateProcessTree(candidate) {
        queueMicrotask(() => candidate.emit("close", null, "SIGTERM"));
      },
    });
    const interruption = Object.freeze({ signal: new AbortController().signal, interruption: null });

    try {
      const started = await registry.start({
        runId: "run-1", actionId: "action-1", environmentId: "environment-1",
        executable: "shell", args: ["command"], cwd: directory, environment: {}, timeoutMs: 5_000,
        interruption, termination: { gracePeriodMs: 10, forceKillTimeoutMs: 20 },
        outputAbsolutePath: outputPath, outputRelativePath: "task.log", maximumOutputBytes: 1_024,
      });
      child.stdout!.write("ready\n");
      expect(started).toMatchObject({ status: "running", process: { runId: "run-1", processId: 4242 } });
      expect(registry.isExactActive(started.process)).toBe(true);

      const stopped = await registry.stop(started.process);
      expect(stopped).toMatchObject({ status: "cancelled", signal: "SIGTERM" });
      expect(registry.isExactActive(started.process)).toBe(false);
      expect(await readFile(outputPath, "utf8")).toContain("ready");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("finalizes every active task owned by one Run without touching another Run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-process-finalize-"));
    const children = [fakeChild(1), fakeChild(2)];
    let index = 0;
    const registry = new RunProcessTaskRegistry(3, 4, {
      spawnProcess: () => children[index++]!,
      terminateProcessTree(child) { queueMicrotask(() => child.emit("close", null, "SIGTERM")); },
    });
    const interruption = Object.freeze({ signal: new AbortController().signal, interruption: null });
    try {
      const first = await registry.start(startInput("run-a", "action-a", 1, directory, interruption));
      const second = await registry.start(startInput("run-b", "action-b", 2, directory, interruption));
      expect(await registry.finalizeRun("run-a")).toBe(true);
      expect(registry.isExactActive(first.process)).toBe(false);
      expect(registry.isExactActive(second.process)).toBe(true);
      await registry.finalizeRun("run-b");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports Run finalization failure when process termination cannot be confirmed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-process-unknown-"));
    const child = fakeChild(3);
    const registry = new RunProcessTaskRegistry(1, 2, {
      spawnProcess: () => child,
      terminateProcessTree() {},
    });
    const interruption = Object.freeze({ signal: new AbortController().signal, interruption: null });

    try {
      await registry.start({
        ...startInput("run-unknown", "action-unknown", 3, directory, interruption),
        termination: { gracePeriodMs: 1, forceKillTimeoutMs: 1 },
      });

      await expect(registry.finalizeRun("run-unknown")).resolves.toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function fakeChild(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid, stdout: new PassThrough(), stderr: new PassThrough() });
  return child;
}

function startInput(runId: string, actionId: string, ordinal: number, directory: string, interruption: { readonly signal: AbortSignal; readonly interruption: null }) {
  return {
    runId, actionId, environmentId: "environment-1", executable: "shell", args: ["command"],
    cwd: directory, environment: {}, timeoutMs: 5_000, interruption,
    termination: { gracePeriodMs: 10, forceKillTimeoutMs: 20 },
    outputAbsolutePath: join(directory, `task-${ordinal}.log`), outputRelativePath: `task-${ordinal}.log`, maximumOutputBytes: 1_024,
  };
}
