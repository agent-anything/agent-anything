import type { ObservationEnvelope, RunActionRef } from "@agent-anything/agent-core/run-action";
import type { OperationResult } from "@agent-anything/operation-catalog/result";
import type { ToolResult } from "@agent-anything/tools/result";
import type { PlanUpdateOutcome } from "../plan/PlanObservation.js";

export interface RunObservationLowerRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string | null;
}

export type RunObservationPayload =
  | { readonly kind: "plan_update"; readonly result: PlanUpdateOutcome }
  | { readonly kind: "handoff"; readonly status: "applied" | "rejected"; readonly code: string | null }
  | { readonly kind: "operation"; readonly result: OperationResult; readonly toolResult: ToolResult | null }
  | { readonly kind: "operation_rejected"; readonly owner: string; readonly code: string; readonly message: string }
  | { readonly kind: "interaction"; readonly owner: string; readonly status: "resolved" | "expired" | "cancelled" | "invalidated" | "failed"; readonly value: unknown };

export interface RunObservation {
  readonly id: string;
  readonly runId: string;
  readonly actionId: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly owner: string;
  readonly runAction: RunActionRef;
  readonly lowerRefs: readonly RunObservationLowerRef[];
  readonly payload: RunObservationPayload;
}

export type RunObservationEnvelope = ObservationEnvelope<RunObservationPayload>;

export function createRunObservation(input: RunObservation): RunObservation {
  return deepFreeze({
    ...input,
    lowerRefs: [...input.lowerRefs],
    metadata: { ...input.metadata },
  });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
