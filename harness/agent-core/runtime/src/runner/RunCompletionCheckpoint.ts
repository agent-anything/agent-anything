import type { ControllerTurnRef } from "@agent-anything/agent-core/control";
import type { ControllerCompletionDisposition, ControllerCompletionInput } from "../controller/index.js";
import type { RetainedControllerOperation } from "./RunDecisionCheckpoint.js";

/** The callback boundary is retained without giving Runtime knowledge of Hooks. */
export interface RunCompletionNotificationCheckpoint {
  readonly turn: ControllerTurnRef;
  readonly basisRevision: number;
  readonly prepared: RetainedControllerOperation;
  readonly output: unknown;
  readonly completionSource: ControllerCompletionInput["completionSource"];
  readonly settlements: ControllerCompletionInput["settlements"];
  readonly outcome:
    | { readonly status: "pending" }
    | { readonly status: "returned"; readonly disposition: ControllerCompletionDisposition }
    | { readonly status: "interrupted" }
    | { readonly status: "failed"; readonly errorName: string;
        readonly failure: import("../controller/index.js").ControllerFailure;
        readonly operationSettlement: "unsettled" | "settled_failure";
        readonly deadline: import("../controller/index.js").ControllerOperationDeadline | null };
}

export function completionNotificationDisposition(
  checkpoint: RunCompletionNotificationCheckpoint,
  turn: ControllerTurnRef,
  basisRevision: number,
): ControllerCompletionDisposition {
  if (checkpoint.turn.id !== turn.id || checkpoint.turn.run.id !== turn.run.id ||
      checkpoint.turn.sequence !== turn.sequence || checkpoint.basisRevision !== basisRevision) {
    throw new TypeError("Completion notification does not match the accepted candidate basis.");
  }
  if (checkpoint.outcome.status !== "returned") {
    throw new TypeError("Completion notification has no confirmed disposition.");
  }
  return structuredClone(checkpoint.outcome.disposition);
}
