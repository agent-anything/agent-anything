export interface RuntimeLimits {
  maxToolCalls: number;
  maxDurationMs: number;
  maxConsecutiveFailures: number;
  maxIterations: number;
}
