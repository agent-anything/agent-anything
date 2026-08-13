export type RunLifecycleStatus =
  | "initializing"
  | "running"
  | "waiting"
  | "cancelling"
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled";
