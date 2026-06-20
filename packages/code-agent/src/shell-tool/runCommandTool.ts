import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { TaskWorkspaceScope } from "@agent-anything/agent-core";
import type {
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "@agent-anything/tools";
import {
  resolveExistingTarget,
} from "../file-tools/filesystemBoundary.js";
import { FileToolError } from "../file-tools/FileToolError.js";
import { BoundedOutput } from "./BoundedOutput.js";
import {
  CODE_AGENT_RUN_COMMAND_TOOL,
  type CodeAgentShellLimits,
  type RunCommandOutput,
} from "./ShellToolContracts.js";
import {
  parseRunCommandInput,
  ShellInputError,
  type ParsedRunCommandInput,
} from "./shellInput.js";

export function createRunCommandTool(input: {
  workspaceScope: TaskWorkspaceScope | undefined;
  limits: CodeAgentShellLimits;
  environment?: Readonly<Record<string, string>>;
  now: () => string;
  nowMs: () => number;
}): ToolDefinition<unknown, RunCommandOutput> {
  return {
    name: CODE_AGENT_RUN_COMMAND_TOOL,
    description: "Run a process inside a declared task workspace root.",
    risk: "risky",
    metadata: {
      inputSchema: {
        type: "object",
        required: ["command", "args", "reason"],
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          rootName: { type: "string" },
          cwd: { type: "string" },
          timeoutMs: { type: "integer" },
          reason: { type: "string" },
        },
      },
      shell: false,
      defaultTimeoutMs: input.limits.defaultTimeoutMs,
      maxTimeoutMs: input.limits.maxTimeoutMs,
      maxStdoutBytes: input.limits.maxStdoutBytes,
      maxStderrBytes: input.limits.maxStderrBytes,
    },
    async execute(call) {
      const startedAt = input.now();
      const startedMs = input.nowMs();

      try {
        const commandInput = parseRunCommandInput(
          call.input,
          input.limits,
        );
        const target = await resolveExistingTarget({
          workspaceScope: input.workspaceScope,
          rootName: commandInput.rootName,
          path: commandInput.cwd,
          expectedKind: "directory",
        });
        const processResult = await runProcess({
          commandInput,
          cwd: target.canonicalTarget,
          environment: input.environment,
          limits: input.limits,
          nowMs: input.nowMs,
          startedMs,
        });

        if (processResult.kind === "failed") {
          return failedResult(
            call,
            startedAt,
            input.now(),
            "shell_process_start_failed",
            "Failed to start or monitor the command process.",
          );
        }

        if (processResult.kind === "timeout") {
          return {
            toolCallId: call.id,
            toolName: call.toolName,
            status: "timeout",
            output: null,
            error: {
              code: "shell_timeout",
              message: "Command exceeded the configured timeout.",
              metadata: {
                rootName: target.resolved.rootName,
                workspaceId: target.resolved.workspaceId,
                command: commandInput.command,
                args: commandInput.args,
                cwd: target.resolved.relativePath,
                timeoutMs: commandInput.timeoutMs,
                durationMs: processResult.durationMs,
                stdout: processResult.stdout,
                stderr: processResult.stderr,
                stdoutTruncated: processResult.stdoutTruncated,
                stderrTruncated: processResult.stderrTruncated,
              },
            },
            startedAt,
            finishedAt: input.now(),
            metadata: call.metadata,
          };
        }

        return {
          toolCallId: call.id,
          toolName: call.toolName,
          status: "succeeded",
          output: {
            rootName: target.resolved.rootName,
            workspaceId: target.resolved.workspaceId,
            command: commandInput.command,
            args: [...commandInput.args],
            cwd: target.resolved.relativePath,
            exitCode: processResult.exitCode,
            signal: processResult.signal,
            stdout: processResult.stdout,
            stderr: processResult.stderr,
            durationMs: processResult.durationMs,
            stdoutTruncated: processResult.stdoutTruncated,
            stderrTruncated: processResult.stderrTruncated,
            timedOut: false,
          },
          error: null,
          startedAt,
          finishedAt: input.now(),
          metadata: call.metadata,
        };
      } catch (error) {
        if (error instanceof FileToolError || error instanceof ShellInputError) {
          return failedResult(
            call,
            startedAt,
            input.now(),
            error.code,
            error.message,
            "metadata" in error ? error.metadata : undefined,
          );
        }

        return failedResult(
          call,
          startedAt,
          input.now(),
          "shell_execution_failed",
          "Shell command execution failed.",
        );
      }
    },
  };
}

interface RunProcessInput {
  commandInput: ParsedRunCommandInput;
  cwd: string;
  environment?: Readonly<Record<string, string>>;
  limits: CodeAgentShellLimits;
  nowMs: () => number;
  startedMs: number;
}

type ProcessOutcome =
  | {
    kind: "completed";
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  }
  | {
    kind: "timeout";
    stdout: string;
    stderr: string;
    durationMs: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  }
  | { kind: "failed" };

function runProcess(input: RunProcessInput): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const stdout = new BoundedOutput(input.limits.maxStdoutBytes);
    const stderr = new BoundedOutput(input.limits.maxStderrBytes);
    let child: ChildProcess;

    try {
      child = spawn(
        input.commandInput.command,
        input.commandInput.args,
        {
          cwd: input.cwd,
          env: input.environment === undefined
            ? undefined
            : { ...process.env, ...input.environment },
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch {
      resolve({ kind: "failed" });
      return;
    }

    let timedOut = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      tryKill(child);
      forceKillTimer = setTimeout(() => {
        if (!settled) {
          tryKill(child, "SIGKILL");
        }
      }, 250);
    }, input.commandInput.timeoutMs);

    child.once("error", () => {
      if (timedOut || settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      resolve({ kind: "failed" });
    });

    child.once("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }

      const common = {
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        durationMs: Math.max(0, input.nowMs() - input.startedMs),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };

      if (timedOut) {
        resolve({
          kind: "timeout",
          ...common,
        });
        return;
      }

      resolve({
        kind: "completed",
        exitCode,
        signal,
        ...common,
      });
    });
  });
}

function tryKill(
  child: ChildProcess,
  signal?: NodeJS.Signals,
): void {
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between the timeout and termination attempt.
  }
}
function failedResult<TOutput>(
  call: ToolCall,
  startedAt: string,
  finishedAt: string,
  code: string,
  message: string,
  metadata?: Record<string, unknown>,
): ToolResult<TOutput> {
  return {
    toolCallId: call.id,
    toolName: call.toolName,
    status: "failed",
    output: null,
    error: {
      code,
      message,
      ...(metadata === undefined ? {} : { metadata }),
    },
    startedAt,
    finishedAt,
    metadata: call.metadata,
  };
}
