export interface EvaluationDeadlinePort {
  waitUntil(deadlineAt: string, signal: AbortSignal): Promise<void>;
}

export interface EvaluationOperationControl {
  readonly signal: AbortSignal;
  readonly deadlineAt: string | null;
}

export type EvaluationControlledOperationResult<TValue> =
  | { readonly status: "settled"; readonly value: TValue }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "cancelled" }
  | { readonly status: "timed_out" };

export type EvaluationLateOperationResult<TValue> =
  | { readonly status: "settled"; readonly value: TValue }
  | { readonly status: "failed" };

export async function runControlledOperation<TValue>(
  start: (signal: AbortSignal) => Promise<TValue>,
  control: EvaluationOperationControl,
  deadlinePort: EvaluationDeadlinePort,
  onLateResult?: (result: EvaluationLateOperationResult<TValue>) => void,
): Promise<EvaluationControlledOperationResult<TValue>> {
  if (control.signal.aborted) return Object.freeze({ status: "cancelled" });

  const operationController = new AbortController();
  const onExternalAbort = () => operationController.abort(control.signal.reason);
  control.signal.addEventListener("abort", onExternalAbort, { once: true });

  const operation = Promise.resolve()
    .then(() => start(operationController.signal))
    .then(
      (value) => Object.freeze({ status: "settled" as const, value }),
      (error: unknown) => Object.freeze({ status: "failed" as const, error }),
    );

  const cancellation = new Promise<{ readonly status: "cancelled" }>((resolve) => {
    operationController.signal.addEventListener(
      "abort",
      () => resolve(Object.freeze({ status: "cancelled" })),
      { once: true },
    );
  });

  const contenders: Promise<EvaluationControlledOperationResult<TValue>>[] = [
    operation,
    cancellation,
  ];
  if (control.deadlineAt !== null) {
    contenders.push(deadlinePort.waitUntil(control.deadlineAt, operationController.signal).then(
      () => Object.freeze({ status: "timed_out" as const }),
      () => new Promise<EvaluationControlledOperationResult<TValue>>(() => undefined),
    ));
  }

  const result = await Promise.race(contenders);
  control.signal.removeEventListener("abort", onExternalAbort);

  if (result.status === "cancelled" || result.status === "timed_out") {
    operationController.abort(result.status);
    void operation.then((late) => {
      if (!onLateResult) return;
      onLateResult(late.status === "settled"
        ? Object.freeze({ status: "settled", value: late.value })
        : Object.freeze({ status: "failed" }));
    });
    return result;
  }

  operationController.abort("operation_settled");
  return result;
}
