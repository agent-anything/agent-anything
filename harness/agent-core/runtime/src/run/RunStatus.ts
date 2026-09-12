export type ActiveRunStatus =
  | "initializing"
  | "running"
  | "waiting"
  | "suspended"
  | "cancelling";

export type TerminalRunStatus = "completed" | "failed" | "cancelled";
export type RunStatus = ActiveRunStatus | TerminalRunStatus;
export type RunResultStatus = TerminalRunStatus;
