export type RunLifecycleStatus =
  | "initializing"
  | "running"
  | "waiting_for_approval"
  | "cancelling"
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled";
