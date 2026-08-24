import { spawn as spawnChildProcess, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { CanonicalProcessIdentity } from "@agent-anything/canonical-action/subject";
import { ProcessOutputFile } from "./ProcessOutputFile.js";
import { requestProcessTreeTermination } from "./ProcessExecutor.js";
import type { ProcessTerminationLimits } from "./ProcessContracts.js";

export type ProcessTaskStatus = "running" | "completed" | "failed" | "cancelled" | "timed_out" | "unknown";

export interface ProcessTaskSnapshot {
  readonly runId: string;
  readonly taskId: string;
  readonly status: ProcessTaskStatus;
  readonly process: CanonicalProcessIdentity;
  readonly outputFile: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly outputTruncated: boolean;
}

interface ActiveTask {
  readonly snapshot: ProcessTaskSnapshot;
  readonly child: ChildProcess;
  readonly output: ProcessOutputFile;
  readonly termination: ProcessTerminationLimits;
  readonly completion: Promise<ProcessTaskSnapshot>;
  readonly settle: (snapshot: ProcessTaskSnapshot) => void;
  readonly interruptionSignal: AbortSignal;
  timeout: ReturnType<typeof setTimeout> | null;
  abortListener: (() => void) | null;
  stopping: boolean;
  requestedTerminalStatus: "cancelled" | "timed_out" | "unknown" | null;
}

export interface RunProcessTaskRegistryDependencies {
  readonly spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  readonly terminateProcessTree?: (child: ChildProcess, force: boolean) => void;
}

export interface RunProcessTaskAvailabilitySnapshot {
  readonly runId: string;
  readonly revision: number;
  readonly activeTaskCount: number;
}

export class RunProcessTaskRegistry {
  private readonly tasks = new Map<string, ActiveTask>();
  private readonly settled = new Map<string, ProcessTaskSnapshot>();
  private revision = 0;

  constructor(
    private readonly maximumActiveTasks: number,
    private readonly maximumSettledTasks: number,
    private readonly dependencies: RunProcessTaskRegistryDependencies = {},
  ) {
    if (!Number.isSafeInteger(maximumActiveTasks) || maximumActiveTasks < 1 ||
        !Number.isSafeInteger(maximumSettledTasks) || maximumSettledTasks < 1) {
      throw new TypeError("Process task registry limits must be positive integers.");
    }
  }

  async start(input: {
    readonly runId: string;
    readonly actionId: string;
    readonly environmentId: string;
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly interruption: InvocationInterruptionContext;
    readonly termination: ProcessTerminationLimits;
    readonly outputAbsolutePath: string;
    readonly outputRelativePath: string;
    readonly maximumOutputBytes: number;
  }): Promise<ProcessTaskSnapshot> {
    if (input.interruption.signal.aborted) throw new ProcessTaskRegistryError("process_task_cancelled", "Background task start was cancelled.");
    if (this.tasks.size >= this.maximumActiveTasks) throw new ProcessTaskRegistryError("process_task_limit_exceeded", "The active background task limit was reached.");
    const taskId = `${input.runId}:task:${digestToken(input.actionId)}`;
    if (this.tasks.has(taskId) || this.settled.has(taskId)) throw new ProcessTaskRegistryError("process_task_duplicate", "Background task identity already exists.");
    const output = await ProcessOutputFile.create({
      absolutePath: input.outputAbsolutePath,
      relativePath: input.outputRelativePath,
      maximumBytes: input.maximumOutputBytes,
    });
    const spawnProcess = this.dependencies.spawnProcess ?? spawnChildProcess;
    let child: ChildProcess;
    try {
      child = spawnProcess(input.executable, input.args, {
        cwd: input.cwd,
        env: { ...input.environment },
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      await output.close();
      throw new ProcessTaskRegistryError("process_task_spawn_failed", safeMessage(error));
    }
    if (child.pid === undefined) {
      await output.close();
      throw new ProcessTaskRegistryError("process_task_spawn_failed", "Background process did not expose a process id.");
    }
    const processIdentity = Object.freeze({
      runId: input.runId,
      taskId,
      processId: child.pid,
      environmentId: input.environmentId,
      startFingerprint: `sha256:${createHash("sha256").update(`${input.runId}\0${taskId}\0${child.pid}\0${input.environmentId}`).digest("hex")}`,
    });
    let settle!: (snapshot: ProcessTaskSnapshot) => void;
    const completion = new Promise<ProcessTaskSnapshot>((resolve) => { settle = resolve; });
    const snapshot: ProcessTaskSnapshot = Object.freeze({
      runId: input.runId,
      taskId,
      status: "running",
      process: processIdentity,
      outputFile: input.outputRelativePath,
      exitCode: null,
      signal: null,
      outputTruncated: false,
    });
    const active: ActiveTask = {
      snapshot,
      child,
      output,
      termination: input.termination,
      completion,
      settle,
      interruptionSignal: input.interruption.signal,
      timeout: null,
      abortListener: null,
      stopping: false,
      requestedTerminalStatus: null,
    };
    this.tasks.set(taskId, active);
    this.revision += 1;
    child.stdout?.on("data", (chunk: Buffer) => output.append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.append("stderr", chunk));
    const finish = (status: ProcessTaskStatus, exitCode: number | null, signal: string | null): void => {
      if (!this.tasks.has(taskId)) return;
      this.tasks.delete(taskId);
      this.revision += 1;
      if (active.timeout !== null) clearTimeout(active.timeout);
      if (active.abortListener !== null) input.interruption.signal.removeEventListener("abort", active.abortListener);
      void output.close().then(() => {
        const terminal = Object.freeze({
          ...snapshot,
          status,
          exitCode,
          signal,
          outputTruncated: output.truncated,
        });
        this.retain(terminal);
        settle(terminal);
      });
    };
    child.once("error", () => {
      if (!active.stopping) void this.stopInternal(active, "unknown");
    });
    child.once("close", (exitCode, signal) => finish(active.requestedTerminalStatus ?? "completed", exitCode, signal));
    active.abortListener = () => { void this.stopInternal(active, "cancelled"); };
    input.interruption.signal.addEventListener("abort", active.abortListener, { once: true });
    active.timeout = setTimeout(() => { void this.stopInternal(active, "timed_out"); }, input.timeoutMs);
    if (input.interruption.signal.aborted) void this.stopInternal(active, "cancelled");
    return snapshot;
  }

  get(taskId: string): ProcessTaskSnapshot | null {
    return this.tasks.get(taskId)?.snapshot ?? this.settled.get(taskId) ?? null;
  }

  isExactActive(identity: CanonicalProcessIdentity): boolean {
    const active = this.tasks.get(identity.taskId);
    return active !== undefined && sameProcess(active.snapshot.process, identity);
  }

  getRunAvailability(runId: string): RunProcessTaskAvailabilitySnapshot {
    if (typeof runId !== "string" || runId.length === 0 || runId !== runId.trim()) {
      throw new TypeError("Process task availability requires a canonical Run identity.");
    }
    return Object.freeze({
      runId,
      revision: this.revision,
      activeTaskCount: [...this.tasks.values()].filter(
        (task) => task.snapshot.runId === runId,
      ).length,
    });
  }

  async stop(identity: CanonicalProcessIdentity): Promise<ProcessTaskSnapshot> {
    const active = this.tasks.get(identity.taskId);
    if (active === undefined || !sameProcess(active.snapshot.process, identity)) {
      throw new ProcessTaskRegistryError("process_task_stale", "The exact background process is no longer active.");
    }
    return this.stopInternal(active, "cancelled");
  }

  async finalizeRun(runId: string): Promise<boolean> {
    const active = [...this.tasks.values()].filter((task) => task.snapshot.runId === runId);
    const results = await Promise.all(active.map((task) => this.stopInternal(task, "cancelled").catch(() => null)));
    return results.every((result) => result !== null && result.status !== "unknown") &&
      ![...this.tasks.values()].some((task) => task.snapshot.runId === runId);
  }

  private async stopInternal(
    active: ActiveTask,
    terminalStatus: "cancelled" | "timed_out" | "unknown",
  ): Promise<ProcessTaskSnapshot> {
    if (!this.tasks.has(active.snapshot.taskId)) return active.completion;
    if (!active.stopping) {
      active.stopping = true;
      active.requestedTerminalStatus = terminalStatus;
      const terminate = this.dependencies.terminateProcessTree ?? requestProcessTreeTermination;
      tryTerminate(terminate, active.child, false);
      setTimeout(() => {
        if (this.tasks.has(active.snapshot.taskId)) {
          tryTerminate(terminate, active.child, true);
        }
      }, active.termination.gracePeriodMs);
      setTimeout(() => {
        if (!this.tasks.has(active.snapshot.taskId)) return;
        this.tasks.delete(active.snapshot.taskId);
        this.revision += 1;
        if (active.timeout !== null) clearTimeout(active.timeout);
        if (active.abortListener !== null) {
          active.interruptionSignal.removeEventListener("abort", active.abortListener);
        }
        void active.output.close().then(() => {
          const terminal = Object.freeze({ ...active.snapshot, status: "unknown" as const, outputTruncated: active.output.truncated });
          this.retain(terminal);
          active.settle(terminal);
        });
      }, active.termination.gracePeriodMs + active.termination.forceKillTimeoutMs);
    }
    return active.completion;
  }

  private retain(snapshot: ProcessTaskSnapshot): void {
    this.settled.set(snapshot.taskId, snapshot);
    while (this.settled.size > this.maximumSettledTasks) {
      const oldest = this.settled.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.settled.delete(oldest);
    }
  }
}

export class ProcessTaskRegistryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProcessTaskRegistryError";
  }
}

function sameProcess(left: CanonicalProcessIdentity, right: CanonicalProcessIdentity): boolean {
  return left.runId === right.runId && left.taskId === right.taskId && left.processId === right.processId &&
    left.environmentId === right.environmentId && left.startFingerprint === right.startFingerprint;
}

function digestToken(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Background process could not be started.";
}

function tryTerminate(
  terminate: (child: ChildProcess, force: boolean) => void,
  child: ChildProcess,
  force: boolean,
): void {
  try {
    terminate(child, force);
  } catch {
    // The registry waits for close and otherwise settles as unknown.
  }
}
