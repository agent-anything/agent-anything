import type { OperationInvocationRef } from "@agent-anything/operation-catalog/identity";
import type { ToolCall, ToolCallAttemptRef } from "../invocation/index.js";

export interface ToolSettlementRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string | null;
}

export interface ToolResultBase {
  readonly toolCall: Pick<ToolCall, "toolCallId" | "toolRevision"> | ToolCallAttemptRef;
  readonly settlement: ToolSettlementRef;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ToolResultError {
  readonly code: string;
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type FailedToolResult = ToolResultBase & {
  readonly status: "failed" | "timeout";
  readonly error: ToolResultError;
};

export type ToolResult<TOutput = unknown> =
  | (ToolResultBase & { readonly status: "succeeded"; readonly output: NonNullable<TOutput> })
  | (ToolResultBase & { readonly status: "partial"; readonly output: NonNullable<TOutput>; readonly outputUsability: "validated"; readonly error: ToolResultError })
  | FailedToolResult;

export interface ToolSemanticResult<TOutput = unknown> {
  readonly operationInvocation: OperationInvocationRef;
  readonly status: "succeeded" | "partial" | "failed" | "timeout" | "denied" | "cancelled" | "invalid" | "unavailable" | "unknown_effect";
  readonly output: TOutput | null;
  readonly error: ToolResultError | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ToolSemanticResultAdapter<TOutput = unknown> {
  readonly toolRevision: string;
  adapt(call: ToolCall, result: ToolSemanticResult<TOutput>): ToolResult<TOutput> | null;
}

export function adaptToolSemanticResult<TOutput>(
  call: ToolCall,
  result: ToolSemanticResult<TOutput>,
): ToolResult<TOutput> | null {
  if (
    result.status === "denied" ||
    result.status === "cancelled" ||
    result.status === "invalid" ||
    result.status === "unavailable" ||
    result.status === "unknown_effect"
  ) return null;
  const base = Object.freeze({
    toolCall: Object.freeze({ toolCallId: call.toolCallId, toolRevision: call.toolRevision }),
    settlement: Object.freeze({
      owner: "operation-catalog",
      kind: "operation_invocation",
      id: result.operationInvocation.id,
      revision: result.operationInvocation.operation.revision,
    }),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    metadata: Object.freeze({ ...result.metadata }),
  });
  if (result.status === "succeeded") {
    if (result.output == null) throw new TypeError("Succeeded Tool semantic result requires output.");
    return Object.freeze({ ...base, status: "succeeded" as const, output: result.output as NonNullable<TOutput> });
  }
  if (result.status === "partial") {
    if (result.output == null || result.error === null) throw new TypeError("Partial Tool semantic result requires usable output and error.");
    return Object.freeze({ ...base, status: "partial" as const, output: result.output as NonNullable<TOutput>, outputUsability: "validated" as const, error: result.error });
  }
  if (result.error === null) throw new TypeError("Failed or timed-out Tool semantic result requires an error.");
  return Object.freeze({ ...base, status: result.status, error: result.error });
}
