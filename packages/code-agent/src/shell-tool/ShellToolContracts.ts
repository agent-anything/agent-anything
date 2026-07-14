import type {
  TaskWorkspaceScope,
  ToolExecutionContextResolver,
} from "@agent-anything/agent-core";
import type { ToolDefinition } from "@agent-anything/tools";

export const CODE_AGENT_RUN_COMMAND_TOOL = "codeAgent.runCommand";

export interface CodeAgentShellLimits {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxArgs: number;
  maxCommandBytes: number;
  maxReasonChars: number;
}

export interface CreateCodeAgentShellCapabilityInput {
  workspaceScope: TaskWorkspaceScope | undefined;
  limits?: Partial<CodeAgentShellLimits>;
  environment?: Readonly<Record<string, string>>;
  now?: () => string;
  nowMs?: () => number;
}

export interface RunCommandInput {
  command: string;
  args: string[];
  rootName?: string;
  cwd?: string;
  timeoutMs?: number;
  reason: string;
}

interface RunCommandOutputBase {
  rootName: string;
  workspaceId: string;
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: false;
  settlementConfirmed: boolean;
}

export interface RunCommandCompletedOutput extends RunCommandOutputBase {
  interrupted: false;
  cancellationAttributed: false;
  termination: null;
  settlementConfirmed: true;
}

export interface RunCommandInterruptedOutput extends RunCommandOutputBase {
  interrupted: true;
  cancellationAttributed: boolean;
  termination: "graceful" | "forced";
}

export type RunCommandOutput =
  | RunCommandCompletedOutput
  | RunCommandInterruptedOutput;

export interface CodeAgentShellCapability {
  tool: ToolDefinition<unknown, RunCommandOutput>;
  executionContextResolver: ToolExecutionContextResolver;
}
