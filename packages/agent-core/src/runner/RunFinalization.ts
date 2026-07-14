import type { ISODateTimeString } from "@agent-anything/shared";
import type {
  RunCancellationSummary,
  RunFinalizationContext,
} from "./RunCancellation.js";

export interface RunFinalizationScope {
  readonly context: RunFinalizationContext;
  dispose(): void;
}

export function createRunFinalizationContext(input: {
  readonly runId: string;
  readonly cancellation: RunCancellationSummary | null;
  readonly timeoutMs: number;
  readonly startedAt: ISODateTimeString;
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
  const timer = setTimeout(() => {
    controller.abort(new Error("Run finalization exceeded its deadline."));
  }, input.timeoutMs);
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
