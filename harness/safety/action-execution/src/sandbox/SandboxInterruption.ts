import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
} from "@agent-anything/agent-core/run";

import type {
  SandboxAttempt,
  SandboxCancellationRequest,
  SandboxProvider,
} from "./SandboxContracts.js";

export function observeSandboxInterruption(
  context: InvocationInterruptionContext,
  runId: string,
):
  | { readonly status: "active" }
  | {
      readonly status: "interrupted";
      readonly interruption: InvocationInterruptionRef;
    }
  | { readonly status: "invalid"; readonly message: string } {
  if (!context?.signal || typeof context.signal.aborted !== "boolean") {
    return {
      status: "invalid",
      message: "Sandbox interruption context is invalid.",
    };
  }
  if (!context.signal.aborted) return { status: "active" };
  try {
    const candidate = context.interruption ??
      interruptionFromReason(context.signal.reason, runId);
    if (candidate === null) {
      throw new TypeError("Missing interruption attribution.");
    }
    return {
      status: "interrupted",
      interruption: snapshotSandboxInterruption(candidate, runId),
    };
  } catch (error) {
    return {
      status: "invalid",
      message: safeMessage(error, "Interruption is unattributed."),
    };
  }
}

export function attachProviderCancellation(input: {
  readonly provider: SandboxProvider;
  readonly attempt: SandboxAttempt;
  readonly interruption: InvocationInterruptionContext;
  readonly deadlineAt: string;
  readonly now: () => string;
}) {
  let disposed = false;
  let sent = false;
  const send = (interruption: InvocationInterruptionRef) => {
    if (disposed || sent) return;
    sent = true;
    const request: SandboxCancellationRequest = Object.freeze({
      attemptId: input.attempt.id,
      runId: input.attempt.runId,
      actionId: input.attempt.actionId,
      interruption,
    });
    void input.provider.cancel(request).catch(() => undefined);
  };
  const onAbort = () => {
    const observed = observeSandboxInterruption(
      input.interruption,
      input.attempt.runId,
    );
    if (observed.status === "interrupted") {
      send(observed.interruption);
    }
  };
  input.interruption.signal.addEventListener(
    "abort",
    onAbort,
    { once: true },
  );
  const timeoutMs = Math.max(
    0,
    Date.parse(input.deadlineAt) - Date.parse(input.now()),
  );
  const timer = setTimeout(() => send(Object.freeze({
    kind: "operation_deadline" as const,
    deadline: Object.freeze({
      operationId: input.attempt.id,
      deadlineAt: input.deadlineAt,
    }),
  })), timeoutMs);
  if (input.interruption.signal.aborted) onAbort();
  return Object.freeze({
    dispose() {
      disposed = true;
      clearTimeout(timer);
      input.interruption.signal.removeEventListener("abort", onAbort);
    },
  });
}

export function createLocalInterruption(
  upstream: InvocationInterruptionContext,
  attempt: SandboxAttempt,
  deadlineAt: string,
  now: () => string,
) {
  const controller = new AbortController();
  let interruption: InvocationInterruptionRef | null = null;
  const abort = (next: InvocationInterruptionRef) => {
    if (interruption !== null) return;
    interruption = next;
    controller.abort(next);
  };
  const onAbort = () => {
    const observed = observeSandboxInterruption(upstream, attempt.runId);
    if (observed.status === "interrupted") {
      abort(observed.interruption);
    }
  };
  upstream.signal.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = Math.max(
    0,
    Date.parse(deadlineAt) - Date.parse(now()),
  );
  const timer = setTimeout(() => abort(Object.freeze({
    kind: "operation_deadline" as const,
    deadline: Object.freeze({
      operationId: attempt.id,
      deadlineAt,
    }),
  })), timeoutMs);
  if (upstream.signal.aborted) onAbort();
  if (timeoutMs === 0) {
    abort(Object.freeze({
      kind: "operation_deadline" as const,
      deadline: Object.freeze({
        operationId: attempt.id,
        deadlineAt,
      }),
    }));
  }
  return {
    signal: controller.signal,
    get interruption() {
      return interruption;
    },
    dispose() {
      clearTimeout(timer);
      upstream.signal.removeEventListener("abort", onAbort);
    },
  };
}

function interruptionFromReason(
  reason: unknown,
  runId: string,
): InvocationInterruptionRef | null {
  if (
    reason !== null &&
    typeof reason === "object" &&
    "id" in reason &&
    "runId" in reason &&
    typeof reason.id === "string" &&
    reason.runId === runId
  ) {
    return Object.freeze({
      kind: "run_cancellation" as const,
      cancellation: Object.freeze({ runId, requestId: reason.id }),
    });
  }
  return null;
}

function snapshotSandboxInterruption(
  interruption: InvocationInterruptionRef,
  runId: string,
): InvocationInterruptionRef {
  if (
    interruption?.kind === "run_cancellation" &&
    interruption.cancellation?.runId === runId &&
    isCanonicalToken(interruption.cancellation.requestId)
  ) {
    return deepFreeze({ ...interruption });
  }
  if (
    interruption?.kind === "operation_deadline" &&
    isCanonicalToken(interruption.deadline?.operationId) &&
    isCanonicalDateTime(interruption.deadline?.deadlineAt)
  ) {
    return deepFreeze({ ...interruption });
  }
  throw new TypeError("Sandbox interruption attribution is invalid.");
}

function isCanonicalDateTime(input: unknown): input is string {
  return typeof input === "string" &&
    !Number.isNaN(Date.parse(input)) &&
    new Date(input).toISOString() === input;
}

function isCanonicalToken(input: unknown): input is string {
  return typeof input === "string" &&
    input.length > 0 &&
    input.length <= 1_024 &&
    input === input.trim() &&
    /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(input);
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : fallback;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (
    typeof value !== "object" ||
    value === null ||
    seen.has(value)
  ) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
