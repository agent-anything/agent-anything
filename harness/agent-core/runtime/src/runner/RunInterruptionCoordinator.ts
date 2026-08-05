import type {
  CancellationContext,
  InterruptibleOperationKind,
  RunCancellationRequest,
} from "../run/index.js";

export type ActiveRunOperationKind = Extract<
  InterruptibleOperationKind,
  "controller" | "tool" | "approval_reviewer" | "authority_commit"
>;

export class OperationSettlementTimeoutError extends Error {
  constructor(
    readonly operation: ActiveRunOperationKind,
    readonly interruptionKind: "run_cancellation" | "operation_deadline",
    readonly startedAt: string,
    readonly timeoutMs: number,
  ) {
    super(
      `${interruptionKind} settlement timed out for the ${operation} operation.`,
    );
    this.name = "OperationSettlementTimeoutError";
  }
}

export interface CreateRunInterruptionCoordinatorInput {
  readonly cancellation: CancellationContext;
  readonly operationSettlementTimeoutMs: number;
  readonly now: () => string;
  readonly onCancellationObserved: (request: RunCancellationRequest) => void;
}

interface ActiveOperation {
  readonly kind: ActiveRunOperationKind;
  readonly startedAt: string;
  readonly rejectSettlement: (error: OperationSettlementTimeoutError) => void;
  interruptionTimer: ReturnType<typeof setTimeout> | null;
  settlementTimer: ReturnType<typeof setTimeout> | null;
}

export class RunInterruptionCoordinator {
  private activeOperation: ActiveOperation | null = null;
  private cancellationListener: (() => void) | null = null;

  constructor(
    private readonly input: CreateRunInterruptionCoordinatorInput,
  ) {}

  start(): void {
    if (this.cancellationListener !== null) {
      throw new Error("Cancellation observation is already active.");
    }
    const listener = () => this.observeCancellation();
    this.cancellationListener = listener;
    this.input.cancellation.signal.addEventListener("abort", listener, {
      once: true,
    });
    if (this.input.cancellation.signal.aborted) {
      this.observeCancellation();
    }
  }

  async execute<TValue>(
    kind: ActiveRunOperationKind,
    execute: () => Promise<TValue>,
    interruptionDeadlineAt: string | null = null,
    allowInterruptedStart = false,
  ): Promise<TValue> {
    if (this.activeOperation !== null) {
      throw new Error(
        `Cannot start ${kind} while ${this.activeOperation.kind} is still active.`,
      );
    }
    if (!allowInterruptedStart && this.cancellationRequest() !== null) {
      this.observeCancellation();
      throw this.input.cancellation.signal.reason;
    }

    let rejectSettlement!: (error: OperationSettlementTimeoutError) => void;
    const settlementTimeout = new Promise<never>((_resolve, reject) => {
      rejectSettlement = reject;
    });
    const operationState: ActiveOperation = {
      kind,
      startedAt: this.input.now(),
      rejectSettlement,
      interruptionTimer: null,
      settlementTimer: null,
    };
    this.activeOperation = operationState;
    if (allowInterruptedStart && this.cancellationRequest() !== null) {
      this.observeCancellation();
    }
    if (interruptionDeadlineAt !== null) {
      const delayMs = Math.max(
        0,
        Date.parse(interruptionDeadlineAt) - Date.parse(this.input.now()),
      );
      operationState.interruptionTimer = setTimeout(
        () => this.startSettlementTimer("operation_deadline"),
        delayMs,
      );
    }

    const operation = Promise.resolve().then(() => {
      if (!allowInterruptedStart && this.cancellationRequest() !== null) {
        this.observeCancellation();
        throw this.input.cancellation.signal.reason;
      }
      return execute();
    });

    try {
      return await Promise.race([operation, settlementTimeout]);
    } finally {
      if (this.activeOperation === operationState) {
        this.clearActiveOperation();
      }
    }
  }

  isActive(kind: ActiveRunOperationKind): boolean {
    return this.activeOperation?.kind === kind;
  }

  dispose(): void {
    if (this.cancellationListener !== null) {
      this.input.cancellation.signal.removeEventListener(
        "abort",
        this.cancellationListener,
      );
      this.cancellationListener = null;
    }
    this.clearActiveOperation();
  }

  private cancellationRequest(): RunCancellationRequest | null {
    return this.input.cancellation.request;
  }

  private observeCancellation(): void {
    const request = this.cancellationRequest();
    if (request === null) {
      return;
    }
    this.input.onCancellationObserved(request);
    this.startSettlementTimer("run_cancellation");
  }

  private startSettlementTimer(
    cause: "run_cancellation" | "operation_deadline",
  ): void {
    const operation = this.activeOperation;
    if (operation === null || operation.settlementTimer !== null) {
      return;
    }
    const timeoutMs = this.input.operationSettlementTimeoutMs;
    operation.settlementTimer = setTimeout(() => {
      operation.rejectSettlement(new OperationSettlementTimeoutError(
        operation.kind,
        cause,
        operation.startedAt,
        timeoutMs,
      ));
    }, timeoutMs);
  }

  private clearActiveOperation(): void {
    if (this.activeOperation?.interruptionTimer !== null &&
        this.activeOperation?.interruptionTimer !== undefined) {
      clearTimeout(this.activeOperation.interruptionTimer);
    }
    if (this.activeOperation?.settlementTimer !== null &&
        this.activeOperation?.settlementTimer !== undefined) {
      clearTimeout(this.activeOperation.settlementTimer);
    }
    this.activeOperation = null;
  }
}
