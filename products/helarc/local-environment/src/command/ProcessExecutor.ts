import {
  spawn as spawnChildProcess,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { BoundedOutput } from "./BoundedOutput.js";
import { ProcessOutputFile } from "./ProcessOutputFile.js";
import type { ProcessTerminationLimits } from "./ProcessContracts.js";

export interface ProcessExecutionInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly replaceEnvironment?: boolean;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly outputFile?: {
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly maximumBytes: number;
  };
  readonly interruption: InvocationInterruptionContext;
  readonly termination: ProcessTerminationLimits;
  readonly startedMs: number;
  readonly nowMs: () => number;
}

export interface CapturedProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly outputFile: string | null;
  readonly outputFileTruncated: boolean;
}

export type ProcessExecutionOutcome =
  | { readonly kind: "cancelled_before_start" }
  | ({
      readonly kind: "completed";
      readonly exitCode: number | null;
      readonly signal: string | null;
    } & CapturedProcessOutput)
  | ({
      readonly kind: "cancelled";
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly termination: "graceful" | "forced";
    } & CapturedProcessOutput)
  | ({
      readonly kind: "timeout";
      readonly terminationConfirmed: boolean;
    } & CapturedProcessOutput)
  | ({
      readonly kind: "cancellation_unconfirmed";
      readonly message: string;
    } & CapturedProcessOutput)
  | {
      readonly kind: "failed";
      readonly effectState: "none" | "settled" | "unknown";
    };

export interface ProcessExecutionDependencies {
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  readonly terminateProcessTree?: (
    child: ChildProcess,
    force: boolean,
  ) => void;
}

export async function executeProcess(
  input: ProcessExecutionInput,
  dependencies: ProcessExecutionDependencies = {},
): Promise<ProcessExecutionOutcome> {
  if (input.interruption.signal.aborted) {
    return { kind: "cancelled_before_start" };
  }

  const outputFile = input.outputFile === undefined
    ? null
    : await ProcessOutputFile.create(input.outputFile);

  return new Promise((resolve) => {
    const stdout = new BoundedOutput(input.maxStdoutBytes);
    const stderr = new BoundedOutput(input.maxStderrBytes);
    const spawnProcess = dependencies.spawnProcess ?? spawnChildProcess;
    const terminateProcessTree = dependencies.terminateProcessTree ??
      requestProcessTreeTermination;
    let child: ChildProcess;

    try {
      child = spawnProcess(input.command, input.args, {
        cwd: input.cwd,
        env: input.environment === undefined
          ? undefined
          : input.replaceEnvironment === true
            ? { ...input.environment }
            : { ...process.env, ...input.environment },
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      const close = outputFile === null ? Promise.resolve() : outputFile.close();
      void close.then(() => resolve({ kind: "failed", effectState: outputFile === null ? "none" : "settled" }));
      return;
    }

    let settled = false;
    let terminationCause: "cancellation" | "timeout" | null = null;
    let terminationStage: "graceful" | "forced" = "graceful";
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let forceSettlementTimer: ReturnType<typeof setTimeout> | undefined;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
      outputFile?.append("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
      outputFile?.append("stderr", chunk);
    });

    const captured = (): CapturedProcessOutput => ({
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      durationMs: Math.max(0, input.nowMs() - input.startedMs),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      outputFile: outputFile?.relativePath ?? null,
      outputFileTruncated: outputFile?.truncated ?? false,
    });

    const finish = (outcome: ProcessExecutionOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
      }
      if (forceSettlementTimer !== undefined) {
        clearTimeout(forceSettlementTimer);
      }
      input.interruption.signal.removeEventListener("abort", onAbort);
      const close = outputFile === null ? Promise.resolve() : outputFile.close();
      void close.then(() => resolve(outcome));
    };

    const forceTermination = (): void => {
      if (settled) {
        return;
      }
      terminationStage = "forced";
      terminateProcessTree(child, true);
      forceSettlementTimer = setTimeout(() => {
        if (terminationCause === "cancellation") {
          finish({
            kind: "cancellation_unconfirmed",
            message: "Command process did not close after forced tree termination.",
            ...captured(),
          });
          return;
        }
        finish({
          kind: "timeout",
          terminationConfirmed: false,
          ...captured(),
        });
      }, input.termination.forceKillTimeoutMs);
    };

    const beginTermination = (cause: "cancellation" | "timeout"): void => {
      if (settled || terminationCause !== null) {
        return;
      }
      terminationCause = cause;
      clearTimeout(timeoutTimer);
      terminateProcessTree(child, false);
      graceTimer = setTimeout(
        forceTermination,
        input.termination.gracePeriodMs,
      );
    };

    const onAbort = (): void => beginTermination("cancellation");
    input.interruption.signal.addEventListener("abort", onAbort, { once: true });

    const timeoutTimer = setTimeout(
      () => beginTermination("timeout"),
      input.timeoutMs,
    );

    child.once("error", () => {
      if (terminationCause === null) {
        finish({ kind: "failed", effectState: "unknown" });
      }
    });

    child.once("close", (exitCode, signal) => {
      if (terminationCause === "cancellation") {
        finish({
          kind: "cancelled",
          exitCode,
          signal,
          termination: terminationStage,
          ...captured(),
        });
        return;
      }
      if (terminationCause === "timeout") {
        finish({
          kind: "timeout",
          terminationConfirmed: true,
          ...captured(),
        });
        return;
      }
      finish({
        kind: "completed",
        exitCode,
        signal,
        ...captured(),
      });
    });

    if (input.interruption.signal.aborted) {
      beginTermination("cancellation");
    }
  });
}

export function requestProcessTreeTermination(
  child: ChildProcess,
  force: boolean,
): void {
  const pid = child.pid;
  if (pid === undefined) {
    tryKillChild(child, force);
    return;
  }

  if (process.platform === "win32") {
    try {
      const killer = spawnChildProcess(
        "taskkill",
        ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
        { shell: false, windowsHide: true, stdio: "ignore" },
      );
      killer.unref();
    } catch {
      tryKillChild(child, force);
    }
    return;
  }

  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    tryKillChild(child, force);
  }
}

function tryKillChild(child: ChildProcess, force: boolean): void {
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // Settlement is established only by the child's close event or timeout.
  }
}
