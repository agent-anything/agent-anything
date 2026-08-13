import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import type { OperationResult } from "@agent-anything/operation-catalog/result";
import type { CompositeDefinitionRef } from "../definition/index.js";

export type CompositeNodeTerminalStatus =
  | "succeeded"
  | "partial"
  | "failed"
  | "unavailable"
  | "denied"
  | "cancelled"
  | "timed_out"
  | "invalid"
  | "unknown_effect"
  | "not_selected"
  | "invalidated"
  | "cancelled_before_start";

export interface CompositeNodeSettlement {
  readonly nodeId: string;
  readonly instance: number;
  readonly runAction: RunActionRef | null;
  readonly status: CompositeNodeTerminalStatus;
  readonly result: OperationResult | null;
}

export interface CompositeFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type CompositeResult<TOutput = unknown> = {
  readonly compositeId: string;
  readonly definition: CompositeDefinitionRef;
  readonly status:
    | "succeeded"
    | "partial"
    | "failed"
    | "cancelled"
    | "unknown_effect";
  readonly children: readonly CompositeNodeSettlement[];
  readonly output: TOutput | null;
  readonly failure: CompositeFailure | null;
  readonly startedAt: string;
  readonly finishedAt: string;
};
