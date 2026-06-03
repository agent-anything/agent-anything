import type { ISODateTimeString, Metadata } from "../shared/types";

export type ToolResultStatus = "succeeded" | "failed";

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
