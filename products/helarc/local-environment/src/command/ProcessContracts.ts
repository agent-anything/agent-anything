export interface CodeAgentCommandLimits {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxOutputFileBytes: number;
  maxCommandBytes: number;
  maxDescriptionChars: number;
  maxValidationClaimChars: number;
  maxActiveTasks: number;
  maxSettledTasks: number;
}

export interface ProcessTerminationLimits {
  readonly gracePeriodMs: number;
  readonly forceKillTimeoutMs: number;
}
