import type { TaskWorkspaceScope } from "@agent-anything/agent-core";
import type {
  ToolCall,
  ToolDefinition,
  ToolInvocationContext,
  ToolResult,
} from "@agent-anything/tools";
import { FileToolError } from "../file-tools/FileToolError.js";
import { resolveExistingTarget } from "../file-tools/filesystemBoundary.js";
import {
  executeProcess,
  type CapturedProcessOutput,
  type ProcessExecutionOutcome,
} from "./ProcessExecutor.js";
import {
  CODE_AGENT_RUN_COMMAND_TOOL,
  type CodeAgentShellLimits,
  type RunCommandOutput,
} from "./ShellToolContracts.js";
import {
  parseRunCommandInput,
  ShellInputError,
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
    async execute(call, context) {
      const startedAt = input.now();
      const startedMs = input.nowMs();

      try {
        const beforeStart = interruptionResult(call, startedAt, input.now(), context);
        if (beforeStart !== null) {
          return beforeStart;
        }

        const commandInput = parseRunCommandInput(call.input, input.limits);
        const target = await resolveExistingTarget({
          workspaceScope: input.workspaceScope,
          rootName: commandInput.rootName,
          path: commandInput.cwd,
          expectedKind: "directory",
        });
        const afterResolution = interruptionResult(
          call,
          startedAt,
          input.now(),
          context,
        );
        if (afterResolution !== null) {
          return afterResolution;
        }

        const processResult = await executeProcess({
          command: commandInput.command,
          args: commandInput.args,
          cwd: target.canonicalTarget,
          environment: input.environment,
          timeoutMs: commandInput.timeoutMs,
          maxStdoutBytes: input.limits.maxStdoutBytes,
          maxStderrBytes: input.limits.maxStderrBytes,
          interruption: context.interruption,
          termination: context.processTermination,
          startedMs,
          nowMs: input.nowMs,
        });

        const targetMetadata = {
          rootName: target.resolved.rootName,
          workspaceId: target.resolved.workspaceId,
          command: commandInput.command,
          args: commandInput.args,
          cwd: target.resolved.relativePath,
        };

        if (processResult.kind === "cancelled_before_start") {
          return interruptionResult(call, startedAt, input.now(), context) ??
            failedResult(
              call,
              startedAt,
              input.now(),
              "tool_cancellation_unconfirmed",
              "Command was not started because interruption attribution was unavailable.",
            );
        }
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
          return timeoutResult(
            call,
            startedAt,
            input.now(),
            commandInput.timeoutMs,
            targetMetadata,
            processResult,
          );
        }
        if (processResult.kind === "cancellation_unconfirmed") {
          return {
            toolCallId: call.id,
            toolName: call.toolName,
            status: "interrupted",
            output: processOutput(
              targetMetadata,
              processResult,
              null,
              null,
              true,
              false,
              "forced",
              false,
            ),
            error: {
              code: "tool_cancellation_unconfirmed",
              message: processResult.message,
            },
            startedAt,
            finishedAt: input.now(),
            metadata: call.metadata,
          };
        }
        if (processResult.kind === "cancelled") {
          const cancellation = context.interruption.interruption;
          const exact = cancellation?.kind === "run_cancellation";
          return {
            toolCallId: call.id,
            toolName: call.toolName,
            status: "interrupted",
            output: processOutput(
              targetMetadata,
              processResult,
              processResult.exitCode,
              processResult.signal,
              true,
              exact,
              processResult.termination,
              true,
            ),
            error: exact
              ? {
                  code: "shell_cancelled",
                  message: "Command process was terminated after Run cancellation.",
                  metadata: {
                    runId: cancellation.cancellation.runId,
                    requestId: cancellation.cancellation.requestId,
                  },
                }
              : {
                  code: "tool_cancellation_unconfirmed",
                  message: "Command process stopped without trusted Run cancellation attribution.",
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
          output: processOutput(
            targetMetadata,
            processResult,
            processResult.exitCode,
            processResult.signal,
            false,
            false,
            null,
            true,
          ),
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

function processOutput(
  target: {
    rootName: string;
    workspaceId: string;
    command: string;
    args: readonly string[];
    cwd: string;
  },
  captured: CapturedProcessOutput,
  exitCode: number | null,
  signal: string | null,
  interrupted: boolean,
  cancellationAttributed: boolean,
  termination: "graceful" | "forced" | null,
  settlementConfirmed: boolean,
): RunCommandOutput {
  const common = {
    ...target,
    args: [...target.args],
    exitCode,
    signal,
    stdout: captured.stdout,
    stderr: captured.stderr,
    durationMs: captured.durationMs,
    stdoutTruncated: captured.stdoutTruncated,
    stderrTruncated: captured.stderrTruncated,
    timedOut: false as const,
    settlementConfirmed,
  };
  return interrupted
    ? {
        ...common,
        interrupted: true,
        cancellationAttributed,
        termination: termination ?? "forced",
      }
    : {
        ...common,
        interrupted: false,
        cancellationAttributed: false,
        termination: null,
        settlementConfirmed: true,
      };
}

function timeoutResult(
  call: ToolCall,
  startedAt: string,
  finishedAt: string,
  timeoutMs: number,
  target: Record<string, unknown>,
  outcome: Extract<ProcessExecutionOutcome, { kind: "timeout" }>,
): ToolResult<RunCommandOutput> {
  return {
    toolCallId: call.id,
    toolName: call.toolName,
    status: "timeout",
    output: null,
    error: {
      code: outcome.terminationConfirmed
        ? "shell_timeout"
        : "shell_timeout_termination_unconfirmed",
      message: outcome.terminationConfirmed
        ? "Command exceeded the configured timeout."
        : "Command exceeded its timeout and process termination could not be confirmed.",
      metadata: {
        ...target,
        timeoutMs,
        durationMs: outcome.durationMs,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        stdoutTruncated: outcome.stdoutTruncated,
        stderrTruncated: outcome.stderrTruncated,
        terminationConfirmed: outcome.terminationConfirmed,
      },
    },
    startedAt,
    finishedAt,
    metadata: call.metadata,
  };
}

function interruptionResult(
  call: ToolCall,
  startedAt: string,
  finishedAt: string,
  context: ToolInvocationContext,
): ToolResult<RunCommandOutput> | null {
  if (!context.interruption.signal.aborted) {
    return null;
  }
  const interruption = context.interruption.interruption;
  if (interruption?.kind === "run_cancellation") {
    return {
      toolCallId: call.id,
      toolName: call.toolName,
      status: "cancelled",
      output: null,
      error: {
        code: "tool_cancelled",
        message: "Command was cancelled before process execution.",
        metadata: {
          runId: interruption.cancellation.runId,
          requestId: interruption.cancellation.requestId,
        },
      },
      startedAt,
      finishedAt,
      metadata: call.metadata,
    };
  }
  if (interruption?.kind === "operation_deadline") {
    return {
      toolCallId: call.id,
      toolName: call.toolName,
      status: "timeout",
      output: null,
      error: {
        code: "tool_timeout",
        message: "Command operation exceeded its invocation deadline.",
        metadata: {
          operationId: interruption.deadline.operationId,
          deadlineAt: interruption.deadline.deadlineAt,
        },
      },
      startedAt,
      finishedAt,
      metadata: call.metadata,
    };
  }
  return {
    toolCallId: call.id,
    toolName: call.toolName,
    status: "interrupted",
    output: null,
    error: {
      code: "tool_cancellation_unconfirmed",
      message: "Command was aborted without trusted interruption attribution.",
    },
    startedAt,
    finishedAt,
    metadata: call.metadata,
  };
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
