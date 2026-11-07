import {randomUUID} from "node:crypto";
import {performance} from "node:perf_hooks";
import {threadId} from "node:worker_threads";
const clockDomain=randomUUID();
export function executionPerformanceClock():{clockDomain:string;monotonicMs:number}{return {clockDomain,monotonicMs:performance.now()};}

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
  const cpu = readThreadCpu(), utilization = performance.eventLoopUtilization();
  const sampleContext = {...context, measuredThreadId: threadId, cpuBasis: cpu ? "current_thread" : "unavailable"};
  const emit = (event: ExecutionPerformanceEvent) => {try {sink.performance?.(event);} catch { /* Observation is not execution. */ }};
  emit({id, stage, context:{...sampleContext,...executionPerformanceClock()}, kind: "started", occurredAt: new Date().toISOString()});
  let finished = false;
  return (outcome: "ok" | "failed" | "unknown" = "ok", counters?: Readonly<Record<string, number>>) => {
    if (finished) return;
    finished = true;
    const current = readThreadCpu(), loop = performance.eventLoopUtilization(utilization);
    emit({id, stage, context:{...context,measuredThreadId:threadId,cpuBasis:cpu&&current?"current_thread":"unavailable",...executionPerformanceClock()}, kind: "finished", outcome, durationMs: performance.now() - started, occurredAt: new Date().toISOString(),
      counters: {...counters, ...(cpu && current ? {"thread.cpuUserUs":Math.max(0,current.user-cpu.user),"thread.cpuSystemUs":Math.max(0,current.system-cpu.system)} : {}),
        "loop.activeUs":Math.max(0,Math.round(loop.active*1000)),"loop.idleUs":Math.max(0,Math.round(loop.idle*1000))}});
  };
}

function readThreadCpu():NodeJS.CpuUsage|null {
  try {return typeof process.threadCpuUsage === "function" ? process.threadCpuUsage() : null;}
  catch {return null;}
}

export function measureExecutionSync<T>(sink: ExecutionPerformanceSink | undefined, stage: string, context: PerformanceContext, work: () => T): T {
  const end = beginExecutionTiming(sink, stage, context);
  try {const result = work(); end(); return result;} catch (error) {end("failed"); throw error;}
}

export async function measureExecutionAsync<T>(sink: ExecutionPerformanceSink | undefined, stage: string, context: PerformanceContext, work: () => Promise<T>): Promise<T> {
  const end = beginExecutionTiming(sink, stage, context);
  try {const result = await work(); end(); return result;} catch (error) {end("failed"); throw error;}
}
