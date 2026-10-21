import {randomUUID} from "node:crypto";

export type PerformanceContext = Readonly<Record<string, string | number | boolean | null>>;
export type ExecutionPerformanceEvent = {
  readonly id: string; readonly stage: string; readonly context: PerformanceContext;
  readonly kind: "started"; readonly occurredAt: string;
} | {
  readonly id: string; readonly stage: string; readonly context: PerformanceContext;
  readonly kind: "finished"; readonly occurredAt: string; readonly durationMs: number;
  readonly outcome: "ok" | "failed" | "unknown";
  readonly counters?: Readonly<Record<string, number>>;
};
export interface ExecutionPerformanceSink { performance?(event: ExecutionPerformanceEvent): void }

export function beginExecutionTiming(sink: ExecutionPerformanceSink | undefined, stage: string, context: PerformanceContext = {}) {
  if (!sink?.performance) return (_outcome: "ok" | "failed" | "unknown" = "ok", _counters?: Readonly<Record<string, number>>) => {};
  const id = randomUUID(), started = performance.now();
  const emit = (event: ExecutionPerformanceEvent) => {try {sink.performance?.(event);} catch { /* Observation is not execution. */ }};
  emit({id, stage, context, kind: "started", occurredAt: new Date().toISOString()});
  let finished = false;
  return (outcome: "ok" | "failed" | "unknown" = "ok", counters?: Readonly<Record<string, number>>) => {
    if (finished) return;
    finished = true;
    emit({id, stage, context, kind: "finished", outcome, durationMs: performance.now() - started, occurredAt: new Date().toISOString(),
      ...(counters ? {counters} : {})});
  };
}

export function measureExecutionSync<T>(sink: ExecutionPerformanceSink | undefined, stage: string, context: PerformanceContext, work: () => T): T {
  const end = beginExecutionTiming(sink, stage, context);
  try {const result = work(); end(); return result;} catch (error) {end("failed"); throw error;}
}

export async function measureExecutionAsync<T>(sink: ExecutionPerformanceSink | undefined, stage: string, context: PerformanceContext, work: () => Promise<T>): Promise<T> {
  const end = beginExecutionTiming(sink, stage, context);
  try {const result = await work(); end(); return result;} catch (error) {end("failed"); throw error;}
}
