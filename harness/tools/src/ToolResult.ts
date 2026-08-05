

export interface ToolResultBase {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
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
  readonly metadata?: Readonly<Record<string, unknown>>;
}
