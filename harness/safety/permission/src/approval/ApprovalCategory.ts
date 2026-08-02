export type ApprovalCategory =
  | "commandExecution"
  | "fileChange"
  | "permissions"
  | "remoteToolCall"
  | "skill"
  | "networkAccess";

export type ApprovalScope = "action" | "run" | "session" | "persistent";
