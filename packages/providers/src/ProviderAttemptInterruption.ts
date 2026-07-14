import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
} from "@agent-anything/shared";
import type { ProviderCallResult } from "./Provider.js";

export type ProviderAttemptInterruptionCause =
  | {
      readonly kind: "upstream";
      readonly interruption: InvocationInterruptionRef;
    }
  | { readonly kind: "attempt_timeout" }
  | { readonly kind: "unattributed_abort" };

export interface ProviderAttemptInterruption {
  readonly signal: AbortSignal;
  readonly cause: ProviderAttemptInterruptionCause | null;
  dispose(): void;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function createProviderAttemptInterruption(
  context: InvocationInterruptionContext,
  timeoutMs: number,
): ProviderAttemptInterruption {
  assertTimeout(timeoutMs);

  const controller = new AbortController();
  let cause: ProviderAttemptInterruptionCause | null = null;
  let disposed = false;

  const abortFromUpstream = () => {
    if (cause !== null) {
      return;
    }
    const interruption = context.interruption;
    cause = interruption === null
      ? Object.freeze({ kind: "unattributed_abort" as const })
      : Object.freeze({
          kind: "upstream" as const,
          interruption,
        });
    controller.abort(context.signal.reason);
  };

  context.signal.addEventListener("abort", abortFromUpstream, { once: true });
  if (context.signal.aborted) {
    abortFromUpstream();
  }

  const timeout = setTimeout(() => {
    if (cause !== null) {
      return;
    }
    cause = Object.freeze({ kind: "attempt_timeout" as const });
    controller.abort(cause);
  }, timeoutMs);

  return Object.freeze({
    signal: controller.signal,
    get cause() {
      return cause;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      clearTimeout(timeout);
      context.signal.removeEventListener("abort", abortFromUpstream);
    },
  });
}

export function providerResultFromInterruption(
  cause: ProviderAttemptInterruptionCause | null,
): ProviderCallResult | null {
  if (cause === null) {
    return null;
  }

  if (cause.kind === "attempt_timeout") {
    return failedResult(
      "timeout",
      "provider_timeout",
      "Provider request timed out.",
    );
  }

  if (cause.kind === "unattributed_abort") {
    return {
      kind: "cancellation_unconfirmed",
      failure: freezeFailure(
        "cancellation",
        "provider_cancellation_unconfirmed",
        "Provider request was aborted without trusted interruption attribution.",
      ),
    };
  }

  if (cause.interruption.kind === "run_cancellation") {
    return {
      kind: "cancelled",
      cancellation: Object.freeze({ ...cause.interruption.cancellation }),
    };
  }

  return failedResult(
    "deadline",
    "provider_operation_deadline",
    "Provider operation deadline was exceeded.",
    {
      operationId: cause.interruption.deadline.operationId,
      deadlineAt: cause.interruption.deadline.deadlineAt,
    },
  );
}

function assertTimeout(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new TypeError(
      `timeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}.`,
    );
  }
}

function failedResult(
  category: string,
  code: string,
  message: string,
  metadata: Record<string, unknown> = {},
): ProviderCallResult {
  return {
    kind: "failed",
    failure: freezeFailure(category, code, message, metadata),
  };
}

function freezeFailure(
  category: string,
  code: string,
  message: string,
  metadata: Record<string, unknown> = {},
) {
  return Object.freeze({
    category,
    code,
    message,
    metadata: Object.freeze({ ...metadata }),
  });
}
