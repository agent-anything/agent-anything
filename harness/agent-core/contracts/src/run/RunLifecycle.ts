export type RunLifecycleStatus =
  | "initializing"
  | "running"
  | "waiting"
  | "suspended"
  | "cancelling"
  | "succeeded"
  | "stopped"
  | "failed"
  | "cancelled";
