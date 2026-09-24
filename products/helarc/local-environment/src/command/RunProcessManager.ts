import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { CanonicalProcessIdentity } from "@agent-anything/canonical-action/subject";
import { ProcessLaunchFailure, type ProcessBackend, type ProcessBackendEvent, type ProcessBackendHandle } from "./ProcessBackend.js";
import { ProcessOutputStore, type ProcessOutputPaths } from "./ProcessOutputStore.js";
import type { ProcessCleanupSummary, ProcessExecutionFact, ProcessExecutionObserver, ProcessObservation, ProcessSnapshot, ProcessTerminationReason } from "./ProcessObservation.js";

export interface ManagedProcessStart {
  readonly runId: string;
  readonly executionId: string;
  readonly actionId: string;
  readonly origin?: NonNullable<ProcessSnapshot["origin"]>;
  readonly environmentId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly deadlineAt: string;
  readonly runSignal: AbortSignal;
  readonly paths: ProcessOutputPaths;
  readonly maximumOutputBytes: number;
  readonly background: boolean;
  readonly displayCommand?: { readonly shell: string; readonly command: string };
  readonly consumeFinalCwd?: () => Promise<string | null>;
  readonly commitFinalCwd?: (path: string) => Promise<string | null>;
}

interface Execution {
  readonly input: ManagedProcessStart;
  snapshot: ProcessSnapshot;
  output: ProcessOutputStore | null;
  handle: ProcessBackendHandle | null;
  launchFinished: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  terminationTimer: ReturnType<typeof setTimeout> | null;
  readonly listeners: Set<() => void>;
  readonly launchAbort: AbortController;
  readonly abort: () => void;
  readonly settled: Promise<void>;
  readonly resolve: () => void;
  closePromise: Promise<void> | null;
  stopPromise: Promise<void> | null;
  observationSequence: number;
  initialObservation: boolean;
  lastOutputNotification: number;
}

export interface RunProcessManagerOptions {
  readonly backend: ProcessBackend;
  readonly maximumActive: number;
  readonly maximumSettled: number;
  readonly startupTimeoutMs?: number;
  readonly terminationTimeoutMs?: number;
  readonly observer?: ProcessExecutionObserver;
  readonly retainOutput?: (runId: string, executionId: string, paths: ProcessOutputPaths) => Promise<void>;
  readonly now?: () => string;
}

export class RunProcessManager {
  private readonly executions = new Map<string, Execution>();
  private readonly expired = new Map<string, string>();
  private readonly closedRuns = new Set<string>();
  private sequence = 0;
  private revision = 0;
  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }

  constructor(private readonly options: RunProcessManagerOptions) {
    for (const value of [options.maximumActive, options.maximumSettled, options.startupTimeoutMs ?? 10_000, options.terminationTimeoutMs ?? 2500]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Process limits must be positive integers.");
    }
  }

  async start(input: ManagedProcessStart): Promise<ProcessSnapshot> {
    if (input.runSignal.aborted || this.closedRuns.has(input.runId)) throw new ProcessManagerError("process_run_closed");
    if (this.executions.has(input.executionId) || this.expired.has(input.executionId)) throw new ProcessManagerError("process_execution_duplicate");
    if ([...this.executions.values()].filter((entry) => entry.snapshot.phase !== "settled").length >= this.options.maximumActive) throw new ProcessManagerError("process_capacity_exceeded");
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || !Number.isFinite(Date.parse(input.deadlineAt))) throw new ProcessManagerError("process_deadline_invalid");
    let resolve!: () => void;
    const settled = new Promise<void>((done) => { resolve = done; });
    const launchAbort = new AbortController();
    const entry: Execution = {
      input, output: null, handle: null, launchFinished: false, timer: null, terminationTimer: null, listeners: new Set(), launchAbort,
      abort: () => { void this.requestTermination(entry, "run_cancelled"); }, settled, resolve,
      closePromise: null, stopPromise: null, observationSequence: 0, initialObservation: false, lastOutputNotification: 0,
      snapshot: immutable({ ref: { runId: input.runId, executionId: input.executionId }, revision: 0, phase: "starting",
        backend: this.options.backend.descriptor, process: null, helperProcessId: null, actionId: input.actionId, origin: input.origin ?? null,
        startedAt: null, finishedAt: null, deadlineAt: null, initialCwd: input.cwd, finalCwd: null, sessionCwd: null,
        cwdDisposition: input.background ? "detached" : "eligible", rootExit: null, termination: null,
        containment: { disposition: "unknown", confirmedAt: null },
        output: { capture: "open", persistence: "pending", retainedBytes: 0, omittedBytes: 0 },
        outcome: null, limitations: [...this.options.backend.descriptor.limitations] }),
    };
    this.executions.set(input.executionId, entry);
    this.revision++;
    input.runSignal.addEventListener("abort", entry.abort, { once: true });
    this.publish(entry, "reserved");
    let attempted = false;
    try {
      entry.output = await ProcessOutputStore.create(input.executionId, input.paths, input.maximumOutputBytes);
      if (input.runSignal.aborted || this.closedRuns.has(input.runId)) throw new ProcessLaunchFailure("process_start_cancelled", "Run closed before launch.", "none");
      const remaining = Date.parse(input.deadlineAt) - Date.parse(this.now());
      if (remaining <= 0) throw new ProcessLaunchFailure("process_run_deadline", "Run deadline elapsed before launch.", "none");
      attempted = true;
      this.publish(entry, "launching");
      const earlyEvents:ProcessBackendEvent[]=[];
      const handle = await this.options.backend.launch({ executionId: input.executionId, executable: input.executable,
        args: input.args, cwd: input.cwd, environment: input.environment, signal: launchAbort.signal,
        startupTimeoutMs: Math.min(remaining, this.options.startupTimeoutMs ?? 10_000) }, (event) => {
          if(entry.launchFinished)this.event(entry,event);
          else earlyEvents.push(event);
        });
      entry.handle = handle;
      entry.launchFinished = true;
      const startedAt = this.now();
      const remainingAtStart = Date.parse(input.deadlineAt) - Date.parse(startedAt);
      const timeout = Math.max(0, Math.min(input.timeoutMs, remainingAtStart));
      this.change(entry, { startedAt, deadlineAt: new Date(Date.parse(startedAt) + timeout).toISOString(),
        helperProcessId: handle.helperProcessId,
        process: { runId: input.runId, taskId: input.executionId, processId: handle.processId, environmentId: input.environmentId,
          startFingerprint: `sha256:${createHash("sha256").update(`${input.executionId}\0${handle.startIdentity}`).digest("hex")}` },
        phase: entry.snapshot.phase === "starting" ? "running" : entry.snapshot.phase,
        containment: entry.snapshot.containment.disposition === "empty" ? entry.snapshot.containment : { disposition: "active", confirmedAt: null } });
      this.publish(entry, "started");
      for(const event of earlyEvents)this.event(entry,event);
      if (entry.snapshot.containment.disposition !== "empty") {
        entry.timer = setTimeout(() => { void this.requestTermination(entry,
          remainingAtStart <= input.timeoutMs ? "run_deadline" : "execution_timeout"); }, timeout);
      }
      if (input.runSignal.aborted || entry.snapshot.termination !== null || this.closedRuns.has(input.runId)) {
        entry.stopPromise = null;
        void this.requestTermination(entry, entry.snapshot.termination?.reason ?? "run_cancelled");
      }
      this.maybeSettle(entry);
      return entry.snapshot;
    } catch (error) {
      entry.launchFinished = true;
      const noEffect = !attempted || (error instanceof ProcessLaunchFailure && error.effectState === "none");
      this.change(entry, { limitations: [...entry.snapshot.limitations, error instanceof Error ? error.message : "process_launch_failed"],
        containment: { disposition: noEffect ? "empty" : "unknown", confirmedAt: noEffect ? this.now() : null },
        output: { ...entry.snapshot.output, capture: "incomplete" }, outcome: noEffect ? "failed" : "unknown" });
      if (noEffect) { this.change(entry, { phase: "draining" }); this.publish(entry, "scope_empty"); await this.settle(entry); }
      else { this.change(entry, { phase: "unresolved" }); this.publish(entry, "unresolved"); }
      throw new ProcessManagerError(error instanceof ProcessLaunchFailure ? error.code : "process_start_failed", entry.snapshot);
    }
  }

  get(runId: string, executionId: string): ProcessSnapshot { return this.find(runId, executionId).snapshot; }
  getDisplayDescriptor(runId: string, executionId: string) {
    const entry = this.find(runId, executionId);
    return { shell: entry.input.displayCommand?.shell ?? null, command: entry.input.displayCommand?.command ?? null };
  }
  readOutput(runId: string, executionId: string, cursor?: string) {
    const entry = this.find(runId, executionId);
    if (!entry.output) throw new ProcessManagerError("process_output_unavailable");
    return { ...entry.output.read(cursor), snapshot: entry.snapshot };
  }
  getOutputPaths(runId: string, executionId: string): ProcessOutputPaths {
    return { ...this.find(runId, executionId).input.paths };
  }
  getOutputArtifacts(runId: string): readonly ProcessOutputPaths[] {
    return Object.freeze([...this.executions.values()].filter(entry => entry.input.runId === runId)
      .map(entry => Object.freeze({...entry.input.paths})));
  }
  getRunAvailability(runId: string) {
    const entries = [...this.executions.values()].filter((entry) => entry.input.runId === runId);
    return Object.freeze({ runId, revision: this.revision,
      activeTaskCount: entries.filter((entry) => !["settled", "draining"].includes(entry.snapshot.phase)).length,
      retainedTaskCount: entries.length });
  }
  isExactActive(identity: CanonicalProcessIdentity): boolean {
    const entry = this.executions.get(identity.taskId);
    return entry !== undefined && entry.input.runId === identity.runId &&
      entry.snapshot.process?.startFingerprint === identity.startFingerprint && entry.snapshot.process.processId === identity.processId &&
      entry.snapshot.containment.disposition !== "empty";
  }

  async observe(input: { runId: string; executionId: string; invocationId: string; cursor?: string; waitMs: number; requestedWaitMs?:number; signal: AbortSignal; initial?: boolean }): Promise<ProcessObservation> {
    const entry = this.find(input.runId, input.executionId);
    if (entry.output === null) throw new ProcessManagerError("process_output_unavailable", entry.snapshot);
    if (!Number.isSafeInteger(input.waitMs) || input.waitMs < 0 || input.waitMs > 30_000) throw new ProcessManagerError("process_wait_invalid");
    if (input.initial && entry.initialObservation) throw new ProcessManagerError("process_initial_observation_consumed");
    if (input.initial) entry.initialObservation = true;
    entry.output.hasUnread(input.cursor);
    const started = performance.now();
    const before = entry.snapshot.revision;
    const observationId = `${input.executionId}:observation:${++entry.observationSequence}`;
    const details = {observationId, invocationId: input.invocationId, waitMs: input.waitMs, requestedWaitMs:input.requestedWaitMs ?? input.waitMs, cursor: input.cursor ?? null};
    this.publish(entry, "observation_started", details);
    try {
      await this.wait(entry, input.signal, input.waitMs, () => entry.snapshot.phase === "settled" || entry.snapshot.phase === "unresolved" ||
        (!input.initial && (entry.output!.hasUnread(input.cursor) || entry.snapshot.revision !== before)));
    } catch (error) {
      if(input.initial && entry.snapshot.cwdDisposition === "eligible") this.change(entry, {cwdDisposition:"detached"});
      this.publish(entry,"observation_cancelled",details);
      throw error;
    }
    if (input.initial) {
      if (entry.snapshot.phase === "settled" && entry.snapshot.cwdDisposition === "eligible") {
        const committed = entry.snapshot.finalCwd === null ? null : await entry.input.commitFinalCwd?.(entry.snapshot.finalCwd) ?? null;
        this.change(entry, { sessionCwd: committed, cwdDisposition: committed !== null ? "committed" : entry.snapshot.finalCwd === null ? "unavailable" : "unchanged" });
      } else if (entry.snapshot.cwdDisposition === "eligible") this.change(entry, { cwdDisposition: "detached" });
      this.publish(entry, "cwd");
    }
    if (input.signal.aborted) throw new ProcessManagerError("process_observation_cancelled", entry.snapshot);
    const changed = entry.snapshot.revision !== before;
    const output = entry.output.read(input.cursor);
    this.refreshOutput(entry);
    const observation: ProcessObservation = immutable({
      id: observationId, invocationId: input.invocationId,
      execution: entry.snapshot.ref, snapshot: entry.snapshot, requestedWaitMs: input.requestedWaitMs ?? input.waitMs, effectiveWaitMs: input.waitMs,
      elapsedWaitMs: Math.max(0, performance.now() - started),
      returnReason: entry.snapshot.phase === "settled" ? "process_settled" : input.waitMs === 0 ? "immediate_snapshot" :
        input.initial ? "initial_wait_limit" : output.stdout.text.length + output.stderr.text.length > 0 ? "output_available" :
        changed ? "lifecycle_changed" : "observation_wait_limit", ...output,
    });
    this.publish(entry, "observation_returned", { ...details, observation });
    return observation;
  }

  async stop(identity: CanonicalProcessIdentity, requestId?: string): Promise<ProcessSnapshot> {
    const entry = this.find(identity.runId, identity.taskId);
    if (entry.snapshot.process?.startFingerprint !== identity.startFingerprint || entry.snapshot.process.processId !== identity.processId) throw new ProcessManagerError("process_task_identity_mismatch", entry.snapshot);
    if (entry.snapshot.containment.disposition === "empty") return entry.snapshot;
    await this.requestTermination(entry, "model_stop", requestId);
    return entry.snapshot;
  }

  async finalizeRun(context: { runId: string; deadlineAt: string; signal: AbortSignal }): Promise<ProcessCleanupSummary> {
    this.closedRuns.add(context.runId);
    const entries = [...this.executions.values()].filter((entry) => entry.input.runId === context.runId);
    await Promise.all(entries.map(async (entry) => {
      if (entry.snapshot.containment.disposition !== "empty") void this.requestTermination(entry, "run_finalization");
      try { await this.wait(entry, context.signal, Math.max(0, Date.parse(context.deadlineAt) - Date.parse(this.now())), () => entry.snapshot.phase === "settled"); } catch {}
      this.publish(entry,"finalized",{cleanupConfirmed:entry.snapshot.phase === "settled" && entry.snapshot.output.persistence !== "failed"});
    }));
    return immutable({ runId: context.runId,
      completed: entries.every((entry) => entry.snapshot.phase === "settled" && entry.snapshot.output.persistence !== "failed"),
      executions: entries.map((entry) => entry.snapshot) });
  }

  private find(runId: string, executionId: string): Execution {
    const entry = this.executions.get(executionId);
    if (entry === undefined) {
      const owner = this.expired.get(executionId);
      throw new ProcessManagerError(owner === undefined ? "process_execution_unavailable" :
        owner === runId ? "process_execution_expired" : "process_execution_foreign_run");
    }
    if (entry.input.runId !== runId) throw new ProcessManagerError("process_execution_foreign_run");
    return entry;
  }

  private event(entry: Execution, event: ProcessBackendEvent): void {
    if (event.kind === "output") {
      entry.output?.append(event.stream, event.bytes);
      this.refreshOutput(entry);
      for (const listener of entry.listeners) listener();
      if (performance.now() - entry.lastOutputNotification > 250) {
        entry.lastOutputNotification = performance.now(); this.publish(entry, "output");
      }
    } else if (event.kind === "root_exit") {
      this.change(entry, { rootExit: { code: event.code, signal: event.signal, observedAt: this.now() } });
      this.publish(entry, "root_exit");
    } else if (event.kind === "scope_empty") {
      if (entry.timer !== null) clearTimeout(entry.timer);
      if (entry.terminationTimer !== null) clearTimeout(entry.terminationTimer);
      this.change(entry, { phase: "draining", containment: { disposition: "empty", confirmedAt: this.now() } });
      this.publish(entry, "scope_empty"); this.maybeSettle(entry);
    } else if (event.kind === "output_closed") {
      this.change(entry, { output: { ...entry.snapshot.output, capture: event.incomplete ? "incomplete" : "closed" } });
      this.maybeSettle(entry);
    } else {
      this.change(entry, { phase: "unresolved", limitations: [...entry.snapshot.limitations, event.code],
        containment: { disposition: entry.snapshot.containment.disposition === "empty" ? "empty" : "unknown", confirmedAt: entry.snapshot.containment.confirmedAt }, outcome: "unknown" });
      this.publish(entry, "unresolved");
      void this.requestTermination(entry, "backend_failure");
    }
  }

  private maybeSettle(entry: Execution): void {
    if (entry.launchFinished && entry.snapshot.containment.disposition === "empty" && entry.snapshot.output.capture !== "open") void this.settle(entry);
  }

  private settle(entry: Execution): Promise<void> {
    if (entry.closePromise !== null) return entry.closePromise;
    entry.closePromise = (async () => {
      if (entry.timer !== null) clearTimeout(entry.timer);
      if (entry.terminationTimer !== null) clearTimeout(entry.terminationTimer);
      entry.input.runSignal.removeEventListener("abort", entry.abort);
      let persistence: "complete" | "failed" = "complete";
      try {
        if (!entry.output) throw new Error("Output capture was not created.");
        await entry.output.close();
      } catch { persistence = "failed"; }
      if (persistence === "complete" && this.options.retainOutput) {
        try { await this.options.retainOutput(entry.input.runId, entry.input.executionId, entry.input.paths); }
        catch {
          persistence = "failed";
          this.change(entry, { limitations: [...entry.snapshot.limitations, "process_output_retention_failed"] });
        }
      }
      let finalCwd: string | null = null;
      try { finalCwd = await entry.input.consumeFinalCwd?.() ?? null; }
      catch { this.change(entry, { limitations: [...entry.snapshot.limitations, "process_final_cwd_unavailable"] }); }
      try { await entry.handle?.close(); } catch { this.change(entry, { limitations: [...entry.snapshot.limitations, "process_backend_close_failed"] }); }
      this.refreshOutput(entry);
      const termination = entry.snapshot.termination?.reason;
      const outcome = termination === "execution_timeout" || termination === "run_deadline" ? "timed_out" :
        termination && termination !== "backend_failure" ? "cancelled" : entry.snapshot.rootExit === null ? entry.snapshot.outcome ?? "unknown" :
        entry.snapshot.rootExit.code === 0 ? "succeeded" : "failed";
      this.change(entry, { phase: "settled", finishedAt: this.now(), finalCwd,
        output: { ...entry.snapshot.output, persistence }, outcome });
      this.publish(entry, "output_settled"); this.publish(entry, "settled"); entry.resolve();
      const settled = [...this.executions.values()].filter((candidate) => candidate.snapshot.phase === "settled" && candidate !== entry &&
        (candidate.snapshot.output.persistence !== "failed" || this.closedRuns.has(candidate.input.runId)));
      while (settled.length >= this.options.maximumSettled) {
        const expired = settled.shift()!;
        this.publish(expired, "retention_expired");
        this.executions.delete(expired.input.executionId);
        this.expired.set(expired.input.executionId, expired.input.runId);
        while (this.expired.size > this.options.maximumSettled) this.expired.delete(this.expired.keys().next().value!);
        this.revision++;
      }
    })();
    return entry.closePromise;
  }

  private requestTermination(entry: Execution, reason: ProcessTerminationReason, requestId?: string): Promise<void> {
    if (entry.snapshot.phase === "settled") return Promise.resolve();
    if (entry.stopPromise !== null) return entry.stopPromise;
    if (entry.snapshot.termination === null) {
      this.change(entry, { phase: entry.snapshot.containment.disposition === "empty" ? "draining" : "stopping",
        termination: { reason, requestedAt: this.now(), method: "none" } });
      this.publish(entry, "termination_requested", requestId ? {requestId} : {});
    }
    entry.launchAbort.abort();
    entry.stopPromise = (async () => {
      if (entry.handle !== null && entry.snapshot.containment.disposition !== "empty") {
        try {
          const method = await entry.handle.terminate();
          this.change(entry, { termination: { ...entry.snapshot.termination!, method } });
        } catch { this.change(entry, { limitations: [...entry.snapshot.limitations, "process_termination_request_failed"] }); }
      }
      await this.wait(entry, new AbortController().signal, this.options.terminationTimeoutMs ?? 2500, () => entry.snapshot.phase === "settled");
      if (entry.snapshot.phase !== "settled") {
        this.change(entry, { phase: "unresolved", outcome: "unknown", limitations: [...entry.snapshot.limitations, "process_cleanup_unconfirmed"] });
        this.publish(entry, "unresolved");
      }
    })();
    return entry.stopPromise;
  }

  private wait(entry: Execution, signal: AbortSignal, ms: number, ready: () => boolean): Promise<void> {
    if (signal.aborted) return Promise.reject(new ProcessManagerError("process_observation_cancelled", entry.snapshot));
    if (ready() || ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (cancelled: boolean) => {
        clearTimeout(timer); entry.listeners.delete(changed); signal.removeEventListener("abort", abort);
        if (cancelled) reject(new ProcessManagerError("process_observation_cancelled", entry.snapshot)); else resolve();
      };
      const changed = () => { if (ready()) finish(false); };
      const abort = () => finish(true);
      const timer = setTimeout(() => finish(false), ms);
      entry.listeners.add(changed); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort(); else changed();
    });
  }

  private refreshOutput(entry: Execution): void {
    if (entry.output === null) return;
    const status = entry.output.status;
    const persistence = status.failure !== null ? "failed" : entry.snapshot.output.persistence;
    const omittedBytes=entry.snapshot.output.capture === "incomplete" ? null:status.omittedBytes;
    if (entry.snapshot.output.retainedBytes === status.retainedBytes &&
        entry.snapshot.output.omittedBytes === omittedBytes &&
        entry.snapshot.output.persistence === persistence) return;
    this.change(entry, { output: { ...entry.snapshot.output, retainedBytes: status.retainedBytes,
      omittedBytes, persistence } });
  }
  private change(entry: Execution, fields: Partial<ProcessSnapshot>): void {
    const wasActive = !["settled", "draining"].includes(entry.snapshot.phase);
    entry.snapshot = immutable({ ...entry.snapshot, ...fields, revision: entry.snapshot.revision + 1 });
    if (wasActive !== !["settled", "draining"].includes(entry.snapshot.phase)) this.revision++;
    for (const listener of entry.listeners) listener();
  }
  private publish(entry: Execution, kind: ProcessExecutionFact["kind"], extra: Partial<ProcessExecutionFact> = {}): void {
    try { void Promise.resolve(this.options.observer?.(immutable({ ...extra, kind, sequence: ++this.sequence,
      occurredAt: this.now(), snapshot: entry.snapshot, ...(entry.output ? {outputPositions:entry.output.positions} : {}) }))).catch(() => {}); } catch {}
  }
}

export class ProcessManagerError extends Error {
  constructor(readonly code: string, readonly snapshot: ProcessSnapshot | null = null) { super(code); this.name = "ProcessManagerError"; }
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
