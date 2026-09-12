export type RunLifecycleStatus =
  | "initializing"
  | "running"
  | "waiting"
  | "suspended"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";
