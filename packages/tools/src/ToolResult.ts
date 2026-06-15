import type { ISODateTimeString, Metadata } from "@agent-anything/shared";

export type ToolResultStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timeout"
  | "skipped"
  | "partial"
  | "interrupted";

export interface ToolResult<TOutput = unknown> {
  toolCallId: string;
  toolName: string;
  status: ToolResultStatus;
  output: TOutput | null;
  error: ToolResultError | null;
  startedAt: ISODateTimeString;
  finishedAt: ISODateTimeString;
  metadata: Metadata;
}

export interface ToolResultError {
  code: string;
  message: string;
  metadata?: Metadata;
}
