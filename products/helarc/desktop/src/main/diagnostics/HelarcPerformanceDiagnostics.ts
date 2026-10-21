import {randomUUID} from "node:crypto";
import {performance} from "node:perf_hooks";
import {stat} from "node:fs/promises";
import {dirname, join} from "node:path";
import {SerializedAtomicFile} from "../persistence/SerializedAtomicFile.js";
import type {ExecutionPerformanceEvent} from "./ExecutionPerformance.js";

type Finished = Extract<ExecutionPerformanceEvent, {kind: "finished"}>;
const counterKeys = new Set(["encode.nodes", "encode.reusedNodes", "encode.reusedBytes", "encode.blockBuilds",
  "decode.nodes", "decode.reusedNodes", "decode.reusedBytes", "content.reads", "content.readBytes", "content.readReuses",
  "content.parses", "content.parseReuses", "content.referenceReuses", "content.closureVisits"]);
const contextKeys = new Set(["command", "wireKind", "runId", "threadId", "productRunId", "commitId", "treeCommitId",
  "generation", "requestId", "revision", "expectedRevision", "recordId", "controllerTurnId", "controllerStatus",
  "materialOperation", "requestBytes", "contentBlocks", "pendingRequests", "pendingBytes", "workerThreadId",
  "wireSequence", "transferOperation", "count", "totalMs", "maxMs", "bodyMs", "boundaryMs", "timingBasis"]);

/** Bounded local timing evidence, independent of authoritative storage and Inspector. */
export class HelarcPerformanceDiagnostics {
  private readonly file: SerializedAtomicFile;
  private readonly sessionId = randomUUID();
  private readonly startedAt = new Date().toISOString();
  private readonly active = new Map<string, ExecutionPerformanceEvent>();
  private readonly recent: Finished[] = [];
  private readonly slowest: Finished[] = [];
  private readonly totals = new Map<string, {count: number; failed: number; unknown: number; totalMs: number; maxMs: number}>();
  private readonly resources: object[] = [];
  private readonly counters = new Map<string, {reports: number; total: number; max: number}>();
  private evicted = 0;
  private writeFailures = 0;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> | null = null;
  private rotated = false;
  private cpu = process.cpuUsage();
  private utilization = performance.eventLoopUtilization();
  private sampledAt = performance.now();

  constructor(path: string) {this.file = new SerializedAtomicFile(path);}

  record(input: ExecutionPerformanceEvent): void {
    try {
      const event = {...input, stage: input.stage.slice(0, 96),
        context: Object.fromEntries(Object.entries(input.context).filter(([key]) => contextKeys.has(key))
          .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 256) : value]))};
      if (event.kind === "started") {
        if (this.active.size >= 64) {this.active.delete(this.active.keys().next().value!); this.evicted++;}
        this.active.set(event.id, event);
      } else {
        this.active.delete(event.id);
        if (!Number.isFinite(event.durationMs) || event.durationMs < 0) return;
        const values = Object.entries(event.counters ?? {}).filter(([key, value]) => counterKeys.has(key) && Number.isSafeInteger(value) && value >= 0);
        event.counters = Object.fromEntries(values);
        for (const [name, value] of values) {
          const key = `${event.stage}:${event.context.command ?? ""}:${name}`;
          if (!this.counters.has(key) && this.counters.size >= 256) {this.counters.delete(this.counters.keys().next().value!); this.evicted++;}
          const total = this.counters.get(key) ?? {reports: 0, total: 0, max: 0};
          total.reports++; total.total = Math.min(Number.MAX_SAFE_INTEGER, total.total + value); total.max = Math.max(total.max, value);
          this.counters.set(key, total);
        }
        this.recent.push(event);
        if (this.recent.length > 64) {this.recent.shift(); this.evicted++;}
        this.slowest.push(event);
        this.slowest.sort((a, b) => b.durationMs - a.durationMs);
        if (this.slowest.length > 32) this.slowest.pop();
        const key = `${event.stage}:${event.context.command ?? ""}`;
        if (!this.totals.has(key) && this.totals.size >= 256) {this.totals.delete(this.totals.keys().next().value!); this.evicted++;}
        const total = this.totals.get(key) ?? {count: 0, failed: 0, unknown: 0, totalMs: 0, maxMs: 0};
        total.count++; total.failed += Number(event.outcome === "failed"); total.unknown += Number(event.outcome === "unknown");
        total.totalMs += event.durationMs; total.maxMs = Math.max(total.maxMs, event.durationMs);
        this.totals.set(key, total);
      }
      this.dirty = true;
      this.schedule();
    } catch {this.evicted++;}
  }

  private schedule(): void {
    if (this.timer) return;
    const expected = performance.now() + 2000;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sample(Math.max(0, performance.now() - expected));
      void this.flush();
    }, 2000);
    this.timer.unref();
  }

  private sample(timerLagMs: number): void {
    const now = performance.now(), cpu = process.cpuUsage(), usage = performance.eventLoopUtilization();
    const memory = process.memoryUsage();
    this.resources.push({occurredAt: new Date().toISOString(), intervalMs: now - this.sampledAt,
      processCpuMs: (cpu.user - this.cpu.user + cpu.system - this.cpu.system) / 1000,
      processRssBytes: memory.rss, hostHeapUsedBytes: memory.heapUsed,
      hostEventLoopUtilization: performance.eventLoopUtilization(usage, this.utilization).utilization, timerLagMs});
    if (this.resources.length > 32) this.resources.shift();
    this.cpu = cpu; this.utilization = usage; this.sampledAt = now; this.dirty = true;
  }

  async flush(): Promise<void> {
    if (this.timer) {clearTimeout(this.timer); this.timer = null;}
    if (this.writing) {await this.writing; return this.flush();}
    if (!this.dirty) {if (this.active.size) this.schedule(); return;}
    this.dirty = false;
    const document = {version: 1, sessionId: this.sessionId, startedAt: this.startedAt, observedAt: new Date().toISOString(),
      processId: process.pid, runtime: {node: process.versions.node, electron: process.versions.electron ?? null, v8: process.versions.v8},
      semantics: "Inclusive wall durations; overlapping stages are not additive. Totals count reports; database reports include per-command count/maxMs and inherit command outcome. Counters measure representation work/bytes, not durations, unique storage or avoided validation. CPU/RSS are process-wide. Bounded diagnostic retention, not an execution journal.",
      evicted: this.evicted, writeFailures: this.writeFailures, active: [...this.active.values()],
      recent: [...this.recent], slowest: [...this.slowest],
      totals: Object.fromEntries([...this.totals].map(([key, value]) => [key, {...value}])),
      counters: Object.fromEntries([...this.counters].map(([key, value]) => [key, {...value}])), resources: [...this.resources]};
    this.writing = this.file.transact(async file => {
      if (!this.rotated) {
        this.rotated = true;
        try {
          const size = await stat(this.file.filePath).then(value => value.size, error => {
            if (error.code === "ENOENT") return 0;
            throw error;
          });
          if (size > 0 && size <= 4 * 1024 * 1024) {
            const previous = await file.readText();
            if (previous) await new SerializedAtomicFile(join(dirname(this.file.filePath), "execution-performance.previous.json"))
              .transact(target => target.replaceText(previous));
          } else if (size > 0) this.evicted++;
        } catch {this.writeFailures++;}
      }
      await file.replaceText(JSON.stringify(document));
    })
      .catch(() => {this.writeFailures++;}).finally(() => {this.writing = null;});
    await this.writing;
    if (this.dirty || this.active.size) this.schedule();
  }
}
