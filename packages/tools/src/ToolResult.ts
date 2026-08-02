import type { ISODateTimeString, Metadata } from "@agent-anything/foundation";

export interface ToolResultBase {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startedAt: ISODateTimeString;
  readonly finishedAt: ISODateTimeString;
  readonly metadata: Readonly<Metadata>;
}

export interface SucceededToolResult<TOutput = unknown> extends ToolResultBase {
  readonly status: "succeeded";
  readonly output: NonNullable<TOutput>;
}

export interface PartialToolResult<TOutput = unknown> extends ToolResultBase {
  readonly status: "partial";
  readonly output: NonNullable<TOutput>;
  readonly outputUsability: "validated";
  readonly error: ToolResultError;
}

export interface FailedToolResult extends ToolResultBase {
  readonly status: "failed";
  readonly error: ToolResultError;
}

export interface TimedOutToolResult extends ToolResultBase {
  readonly status: "timeout";
  readonly error: ToolResultError;
}

export type ToolResult<TOutput = unknown> =
  | SucceededToolResult<TOutput>
  | PartialToolResult<TOutput>
  | FailedToolResult
  | TimedOutToolResult;

export type ToolResultStatus = ToolResult["status"];

export interface ToolResultError {
  readonly code: string;
  readonly message: string;
  readonly metadata?: Readonly<Metadata>;
}
