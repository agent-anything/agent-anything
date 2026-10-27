import type { TaskDecisionActivityRef } from "@agent-anything/agent-core/control";
import type { RunCompletionDisposition, RunCompletionCandidate } from "../decision/index.js";
import type { RetainedControllerOperation } from "./RunDecisionCheckpoint.js";

/** The callback boundary is retained without giving Runtime knowledge of Hooks. */
export interface RunCompletionNotificationCheckpoint {
  readonly turn: TaskDecisionActivityRef;
  readonly basisRevision: number;
  readonly prepared: RetainedControllerOperation;
  readonly output: unknown;
  readonly completionSource: RunCompletionCandidate["completionSource"];
  readonly settlements: RunCompletionCandidate["settlements"];
  readonly outcome:
    | { readonly status: "pending" }
    | { readonly status: "returned"; readonly disposition: RunCompletionDisposition }
    | { readonly status: "interrupted" }
    | { readonly status: "failed"; readonly errorName: string;
        readonly failure: import("../decision/index.js").TaskDecisionActivityFailure;
        readonly operationSettlement: "unsettled" | "settled_failure";
        readonly deadline: import("../decision/index.js").DecisionActivityDeadline | null };
}

export function completionNotificationDisposition(
  checkpoint: RunCompletionNotificationCheckpoint,
  turn: TaskDecisionActivityRef,
  basisRevision: number,
): RunCompletionDisposition {
  if (checkpoint.turn.id !== turn.id || checkpoint.turn.run.id !== turn.run.id ||
      checkpoint.turn.sequence !== turn.sequence || checkpoint.basisRevision !== basisRevision) {
    throw new TypeError("Completion notification does not match the accepted candidate basis.");
  }
  if (checkpoint.outcome.status !== "returned") {
    throw new TypeError("Completion notification has no confirmed disposition.");
  }
  return structuredClone(checkpoint.outcome.disposition);
}
