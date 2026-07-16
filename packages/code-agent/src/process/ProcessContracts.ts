export interface CodeAgentCommandLimits {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxArgs: number;
  maxCommandBytes: number;
  maxReasonChars: number;
}

export interface ProcessTerminationLimits {
  readonly gracePeriodMs: number;
  readonly forceKillTimeoutMs: number;
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
