import type { RunRef } from "../run/index.js";

export interface ControllerTurnRef {
  readonly run: RunRef;
  readonly id: string;
  readonly sequence: number;
}

export interface InvocationCancellationRef {
  readonly runId: string;
  readonly requestId: string;
}

export interface InvocationOperationDeadlineRef {
  readonly operationId: string;
  readonly deadlineAt: string;
}

export type InvocationInterruptionRef =
  | {
      readonly kind: "run_cancellation";
      readonly cancellation: InvocationCancellationRef;
    }
  | {
      readonly kind: "operation_deadline";
      readonly deadline: InvocationOperationDeadlineRef;
    };

export interface InvocationInterruptionContext {
  readonly signal: AbortSignal;
  readonly interruption: InvocationInterruptionRef | null;
}

export interface RunCancellationRequestRef {
  readonly run: RunRef;
  readonly requestId: string;
}

export interface RunCancellationReceiptRef {
  readonly request: RunCancellationRequestRef;
  readonly receiptId: string;
}

export interface RunSteeringCommandRef {
  readonly run: RunRef;
  readonly commandId: string;
}

export interface RunStatusQueryRef {
  readonly run: RunRef;
  readonly queryId: string;
}
