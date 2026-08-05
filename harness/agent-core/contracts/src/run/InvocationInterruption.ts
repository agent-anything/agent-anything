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
