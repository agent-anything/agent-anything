
import type { RunCancellationSummary, RunFinalizationContext } from "../run/index.js";

export interface RunFinalizationScope {
  readonly context: RunFinalizationContext;
  dispose(): void;
}

export function createRunFinalizationContext(input: {
  readonly runId: string;
  readonly cancellation: RunCancellationSummary | null;
  readonly timeoutMs: number;
  readonly startedAt: string;
  readonly currentAt?: string;
}): RunFinalizationScope {
  const startedAtMs = Date.parse(input.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    throw new TypeError("Finalization startedAt must be a valid date-time string.");
  }
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    input.timeoutMs > 2_147_483_647
  ) {
    throw new TypeError(
      "Finalization timeoutMs must be a positive integer no greater than 2147483647.",
    );
  }

  const controller = new AbortController();
  const deadlineAt = new Date(startedAtMs + input.timeoutMs).toISOString();
  const context = Object.freeze({
    runId: input.runId,
    cancellation: input.cancellation,
    deadlineAt,
    signal: controller.signal,
  });
  const remainingMs = input.currentAt === undefined ? input.timeoutMs : Date.parse(deadlineAt) - Date.parse(input.currentAt);
  if (!Number.isFinite(remainingMs)) throw new TypeError("Finalization currentAt must be a valid date-time string.");
  if (remainingMs <= 0) controller.abort(new Error("Run finalization exceeded its original deadline."));
  const timer = setTimeout(() => {
    controller.abort(new Error("Run finalization exceeded its deadline."));
  }, Math.max(0, remainingMs));
  let disposed = false;

  return Object.freeze({
    context,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      clearTimeout(timer);
    },
  });
}
