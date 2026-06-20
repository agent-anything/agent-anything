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

export interface RunCommandOutput {
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
}

export interface CodeAgentShellCapability {
  tool: ToolDefinition<unknown, RunCommandOutput>;
  executionContextResolver: ToolExecutionContextResolver;
}
