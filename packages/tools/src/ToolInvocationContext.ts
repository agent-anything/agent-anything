import type { InvocationInterruptionContext } from "@agent-anything/shared";

export interface ToolProcessTerminationLimits {
  readonly gracePeriodMs: number;
  readonly forceKillTimeoutMs: number;
}

export interface ToolInvocationContext {
  readonly interruption: InvocationInterruptionContext;
  readonly processTermination: ToolProcessTerminationLimits;
}
