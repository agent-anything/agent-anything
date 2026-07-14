export type ApprovalCategory =
  | "commandExecution"
  | "fileChange"
  | "permissions"
  | "mcpToolCall"
  | "skill"
  | "networkAccess";

export type ApprovalScope = "action" | "run" | "session" | "persistent";
