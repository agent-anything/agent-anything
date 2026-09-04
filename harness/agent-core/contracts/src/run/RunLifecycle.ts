export type RunLifecycleStatus =
  | "initializing"
  | "running"
  | "waiting"
  | "suspended"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";
