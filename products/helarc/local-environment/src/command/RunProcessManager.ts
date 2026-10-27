import { createHash, randomUUID } from "node:crypto";
import {describeProcessOutput, type ProcessOutputMaterialView} from "./ProcessOutputMaterials.js";
import {commandObservationBasis, type CommandObservation, type CommandObservationRequest} from "./CommandObservation.js";
import { publishCommandConstraint, type CommandConstraintObserver, type CommandConstraintFact } from "./CommandConstraintObservation.js";
import type { CommandInputContract } from "./CommandInputContract.js";
import { ProcessRecordError, type ProcessCheckpoint, type ProcessRecordPort } from "./ProcessCheckpoint.js";
import { performance } from "node:perf_hooks";
import type { CanonicalProcessIdentity } from "@agent-anything/canonical-action/subject";
import { ProcessLaunchFailure, type ProcessBackend, type ProcessBackendEvent, type ProcessBackendHandle } from "./ProcessBackend.js";
import { ProcessOutputStore, type ProcessOutputPaths } from "./ProcessOutputStore.js";
import type { ProcessCleanupSummary, ProcessExecutionFact, ProcessExecutionObserver, ProcessInitialDelivery, ProcessInputNotification, ProcessObservation, ProcessSnapshot, ProcessTerminationReason } from "./ProcessObservation.js";

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
  checkpointRevision: number;
  launchIntent: boolean;
  recovered: boolean;
  persistence: Promise<void>;
  persistenceFailure: ProcessRecordError | null;
  observations: ProcessObservation[];
  commandObservations: CommandObservation[];
  materialViews: ProcessOutputMaterialView[];
  readonly input: ManagedProcessStart;
  snapshot: ProcessSnapshot;
  output: ProcessOutputStore | null;
  handle: ProcessBackendHandle | null;
  launchFinished: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  runDeadlineTimer: ReturnType<typeof setTimeout> | null;
  terminationTimer: ReturnType<typeof setTimeout> | null;
  readonly listeners: Set<() => void>;
  readonly launchAbort: AbortController;
  readonly abort: () => void;
  readonly settled: Promise<void>;
  readonly resolve: () => void;
  closePromise: Promise<void> | null;
  outputClosePromise: Promise<void> | null;
  cwdPromise: Promise<void> | null;
  stopPromise: Promise<void> | null;
  observationSequence: number;
  initialObservation: boolean;
  initialDelivery: string | null;
  initialSnapshot: ProcessObservation | null;
  deliveryCursor: string | undefined;
  announcedOutputCursor: string | undefined;
  deliveryState: string | null;
  lastOutputNotification: number;
}

export interface RunProcessManagerOptions {
  readonly scopeId?: string;
  readonly records?: ProcessRecordPort;
  readonly constraints?: {readonly ref: CommandInputContract["ref"]; readonly observer?: CommandConstraintObserver};
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
  readonly scopeId: string;
  private readonly executions = new Map<string, Execution>();
  private readonly observationWork = new Map<string, {request: string; work: Promise<CommandObservation>}>();
  private readonly expired = new Map<string, string>();
  private readonly closedRuns = new Set<string>();
  private sequence = 0;
  private revision = 0;
  private readonly notifications = new Map<string, ProcessInputNotification[]>();
  private readonly committedNotifications = new Map<string, readonly ProcessInputNotification[]>();
  private notificationSequence = 0;
  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }

  constructor(private readonly options: RunProcessManagerOptions) {
    this.scopeId = options.scopeId ?? `process-manager:${randomUUID()}`;
    for (const value of [options.maximumActive, options.maximumSettled, options.startupTimeoutMs ?? 10_000, options.terminationTimeoutMs ?? 2500]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Process limits must be positive integers.");
    }
  }

  async start(input: ManagedProcessStart): Promise<ProcessSnapshot> {
    if (input.runSignal.aborted || this.closedRuns.has(input.runId)) throw new ProcessManagerError("process_run_closed");
    if (this.executions.has(input.executionId) || this.expired.has(input.executionId)) throw new ProcessManagerError("process_execution_duplicate");
    const active = [...this.executions.values()].filter((entry) => entry.snapshot.phase !== "settled").length;
    const capacity = {managerId: this.scopeId, activeCount: active, maximumActive: this.options.maximumActive};
    this.constraint(input, "capacity", active < this.options.maximumActive, capacity);
    if (active >= this.options.maximumActive) throw new ProcessManagerError("process_capacity_exceeded", null, capacity);
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || !Number.isFinite(Date.parse(input.deadlineAt))) throw new ProcessManagerError("process_deadline_invalid");
    let resolve!: () => void;
    const settled = new Promise<void>((done) => { resolve = done; });
    const launchAbort = new AbortController();
    const entry: Execution = {
      checkpointRevision: -1, launchIntent: false, recovered: false, persistence: Promise.resolve(), persistenceFailure: null, observations: [], commandObservations: [], materialViews: [],
      input, output: null, handle: null, launchFinished: false, timer: null, runDeadlineTimer: null, terminationTimer: null, listeners: new Set(), launchAbort,
      abort: () => { void this.requestTermination(entry, "run_cancelled"); }, settled, resolve,
      closePromise: null, outputClosePromise: null, cwdPromise: null, stopPromise: null, observationSequence: 0, initialObservation: false,
      initialDelivery: null, initialSnapshot: null, deliveryCursor: undefined, announcedOutputCursor: undefined, deliveryState: null, lastOutputNotification: 0,
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
      await this.flush(entry);
      entry.output = await ProcessOutputStore.create(input.executionId, input.paths, input.maximumOutputBytes);
      if (input.runSignal.aborted || this.closedRuns.has(input.runId)) throw new ProcessLaunchFailure("process_start_cancelled", "Run closed before launch.", "none");
      const remaining = Date.parse(input.deadlineAt) - Date.parse(this.now());
      this.constraint(input, "deadline", remaining > 0, {runDeadlineAt: input.deadlineAt, remainingMs: remaining, timeoutMs: input.timeoutMs, dispatched: false});
      if (remaining <= 0) throw new ProcessLaunchFailure("process_run_deadline", "Run deadline elapsed before launch.", "none");
      entry.launchIntent = true;
      this.publish(entry, "launching");
      await this.flush(entry);
      attempted = true;
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
      this.constraint(input, "execution_deadline", true, {startedAt, timeoutMs: input.timeoutMs, runDeadlineAt: input.deadlineAt,
        effectiveDeadlineAt: new Date(Date.parse(startedAt) + timeout).toISOString(), limitingBasis: input.timeoutMs < remainingAtStart ? "execution_timeout" : "run_deadline", dispatched: true});
      this.change(entry, { startedAt, deadlineAt: new Date(Date.parse(startedAt) + timeout).toISOString(),
        helperProcessId: handle.helperProcessId,
        process: { runId: input.runId, taskId: input.executionId, processId: handle.processId, environmentId: input.environmentId,
          startFingerprint: `sha256:${createHash("sha256").update(`${input.executionId}\0${handle.startIdentity}`).digest("hex")}` },
        phase: entry.snapshot.phase === "starting" ? "running" : entry.snapshot.phase,
        containment: entry.snapshot.containment.disposition === "empty" ? entry.snapshot.containment : { disposition: "active", confirmedAt: null } });
      this.publish(entry, "started");
      for(const event of earlyEvents)this.event(entry,event);
      if (entry.snapshot.containment.disposition !== "empty") {
        entry.runDeadlineTimer = setTimeout(() => { void this.requestTermination(entry, "run_deadline"); }, Math.max(0, remainingAtStart));
        if (entry.snapshot.rootExit === null && input.timeoutMs < remainingAtStart) {
          entry.timer = setTimeout(() => { void this.requestTermination(entry, "execution_timeout"); }, timeout);
        }
      }
      if (input.runSignal.aborted || entry.snapshot.termination !== null || this.closedRuns.has(input.runId)) {
        entry.stopPromise = null;
        void this.requestTermination(entry, entry.snapshot.termination?.reason ?? "run_cancelled");
      }
      this.maybeSettle(entry);
      await this.flush(entry);
      return entry.snapshot;
    } catch (error) {
      if (error instanceof ProcessRecordError) throw error;
      entry.launchFinished = true;
      const noEffect = !attempted || (error instanceof ProcessLaunchFailure && error.effectState === "none");
      this.change(entry, { limitations: [...entry.snapshot.limitations, error instanceof Error ? error.message : "process_launch_failed"],
        containment: { disposition: noEffect ? "empty" : "unknown", confirmedAt: noEffect ? this.now() : null },
        output: { ...entry.snapshot.output, capture: "incomplete" }, outcome: noEffect ? "failed" : "unknown" });
      if (noEffect) { this.change(entry, { phase: "draining" }); this.publish(entry, "scope_empty"); await this.settle(entry); }
      else { this.change(entry, { phase: "unresolved" }); this.publish(entry, "unresolved"); }
      await this.flush(entry);
      throw new ProcessManagerError(error instanceof ProcessLaunchFailure ? error.code : "process_start_failed", entry.snapshot);
    }
  }

  private constraint(input: ManagedProcessStart, stage: CommandConstraintFact["stage"], passed: boolean, basis: CommandConstraintFact["basis"]): void {
    if (!this.options.constraints) return;
    publishCommandConstraint(this.options.constraints.observer, {runId: input.runId, actionId: input.actionId,
      invocationId: input.origin?.invocationId ?? null, executionId: input.executionId, managerId: this.scopeId,
      configuration: this.options.constraints.ref, occurredAt: this.now(), stage, status: passed ? "passed" : "not_satisfied", basis});
  }

  get(runId: string, executionId: string): ProcessSnapshot { return this.find(runId, executionId).snapshot; }
  getRunSnapshots(runId: string): readonly ProcessSnapshot[] {
    return Object.freeze([...this.executions.values()]
      .filter(entry => entry.input.runId === runId).map(entry => entry.snapshot));
  }
  getDisplayDescriptor(runId: string, executionId: string) {
    const entry = this.find(runId, executionId);
    return { shell: entry.input.displayCommand?.shell ?? null, command: entry.input.displayCommand?.command ?? null };
  }
  readInputNotifications(runId: string, afterSequence: number): readonly ProcessInputNotification[] {
    for (const entry of this.executions.values()) if (entry.input.runId === runId && entry.persistenceFailure) throw entry.persistenceFailure;
    if (this.options.records) return Object.freeze([...this.committedNotifications.values()].flat()
      .filter(fact => fact.runId === runId && fact.sequence > afterSequence).sort((a,b) => a.sequence - b.sequence));
    return Object.freeze((this.notifications.get(runId) ?? []).filter(fact => fact.sequence > afterSequence));
  }
  async commitInitialDelivery(input: ProcessInitialDelivery): Promise<void> {
    const key = JSON.stringify({runId: input.runId, executionId: input.executionId, runActionId: input.runActionId,
      settlementId: input.settlementId, observationId: input.observationId, cursor: input.cursor});
    // A Shell call can wrap an internal process-start Action. Bind its committed
    // result to the process receipt, not to equality with that internal Action.
    const entries = input.executionId === null ? [] : [this.find(input.runId, input.executionId)];
    for (const entry of entries) {
      if (entry.initialDelivery !== null) {
        if (entry.initialDelivery !== key) throw new ProcessManagerError("process_initial_delivery_conflict");
        await this.flush(entry);
        continue;
      }
      const baseline = input.observationId === null ? null : entry.initialSnapshot;
      if ((input.observationId !== null && (baseline?.id !== input.observationId || baseline.nextCursor !== input.cursor)) ||
          (input.observationId === null && input.cursor !== null)) {
        throw new ProcessManagerError("process_initial_delivery_invalid");
      }
      entry.initialDelivery = key;
      entry.deliveryCursor = input.cursor ?? undefined;
      entry.announcedOutputCursor = baseline?.availableOutputCursor;
      entry.deliveryState = baseline === null ? null : deliveryState(baseline.snapshot);
      const outputDelivery = {availableCursor: entry.announcedOutputCursor ?? null, presentedCursor: entry.deliveryCursor ?? null};
      // The receipt and facts accumulated since its observation share one durable checkpoint.
      const notification = this.notifyInput(entry, "process_state_changed", false);
      this.publish(entry, "initial_delivery_committed", {delivery: input, outputDelivery});
      if (notification) this.publish(entry, "input_notified", {notification,
        outputDelivery: {availableCursor: entry.announcedOutputCursor ?? null, presentedCursor: entry.deliveryCursor ?? null}});
      await this.flush(entry);
    }
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
    return entry !== undefined && !entry.recovered && entry.input.runId === identity.runId &&
      entry.snapshot.process?.startFingerprint === identity.startFingerprint && entry.snapshot.process.processId === identity.processId &&
      entry.snapshot.containment.disposition !== "empty";
  }

  async observe(input: { runId: string; executionId: string; invocationId: string; cursor?: string; waitMs: number; requestedWaitMs?:number; signal: AbortSignal; initial?: boolean }): Promise<ProcessObservation> {
    const entry = this.find(input.runId, input.executionId);
    const retained = entry.observations.find(item => item.invocationId === input.invocationId);
    if (retained) { await this.flush(entry); return retained; }
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
        (input.initial && entry.snapshot.outcome !== null && entry.snapshot.output.capture !== "open" && entry.snapshot.output.persistence !== "pending") ||
        (!input.initial && (entry.output!.hasUnread(input.cursor) || entry.snapshot.revision !== before)));
    } catch (error) {
      if(input.initial && entry.snapshot.cwdDisposition === "eligible") this.change(entry, {cwdDisposition:"detached"});
      this.publish(entry,"observation_cancelled",details);
      throw error;
    }
    if (input.initial) {
      if (entry.snapshot.rootExit !== null && entry.snapshot.cwdDisposition === "eligible") {
        await this.consumeCwd(entry);
        const committed = entry.snapshot.finalCwd === null ? null : await entry.input.commitFinalCwd?.(entry.snapshot.finalCwd) ?? null;
        this.change(entry, { sessionCwd: committed, cwdDisposition: committed !== null ? "committed" : entry.snapshot.finalCwd === null ? "unavailable" : "unchanged" });
      } else if (entry.snapshot.cwdDisposition === "eligible") this.change(entry, { cwdDisposition: "detached" });
      this.publish(entry, "cwd");
    }
    if (input.signal.aborted) throw new ProcessManagerError("process_observation_cancelled", entry.snapshot);
    const changed = entry.snapshot.revision !== before;
    const output = entry.output.readModelOutput(input.cursor);
    this.refreshOutput(entry);
    const observation: ProcessObservation = immutable({
      id: observationId, invocationId: input.invocationId,
      execution: entry.snapshot.ref, snapshot: entry.snapshot, materials: this.outputMaterials(entry), requestedWaitMs: input.requestedWaitMs ?? input.waitMs, effectiveWaitMs: input.waitMs,
      elapsedWaitMs: Math.max(0, performance.now() - started),
      returnReason: entry.snapshot.phase === "settled" ? "process_settled" : input.initial && entry.snapshot.rootExit !== null ? "command_completed" : input.waitMs === 0 ? "immediate_snapshot" :
        input.initial ? "initial_wait_limit" : output.stdout.text.length + output.stderr.text.length > 0 ? "output_available" :
        changed ? "lifecycle_changed" : "observation_wait_limit", ...output, availableOutputCursor: entry.output.captureCursor(),
    });
    if (input.initial) entry.initialSnapshot = observation;
    entry.observations.push(observation);
    this.publish(entry, "observation_returned", { ...details, observation });
    await this.flush(entry);
    return observation;
  }

  async observeCommand(input: {runId: string; executionId: string; invocationId: string; request: CommandObservationRequest;
    signal: AbortSignal; deadlineAt: string}): Promise<CommandObservation> {
    const entry = this.find(input.runId, input.executionId), request = JSON.stringify(input.request);
    const saved = entry.commandObservations.find(value=>value.invocationId === input.invocationId);
    if (saved) {
      if (JSON.stringify(saved.request) !== request) throw new ProcessManagerError("process_observation_invocation_conflict");
      await this.flush(entry); return saved;
    }
    const key = JSON.stringify([input.runId,input.executionId,input.invocationId]);
    const active = this.observationWork.get(key);
    if (active) {
      if (active.request !== request) throw new ProcessManagerError("process_observation_invocation_conflict");
      return active.work;
    }
    const work = this.executeCommandObservation(entry,input);
    this.observationWork.set(key,{request,work});
    try {return await work;} finally {this.observationWork.delete(key);}
  }

  private outputMaterials(entry: Execution): readonly ProcessOutputMaterialView[] {
    if (!entry.output) return [];
    const views = describeProcessOutput(entry.output.checkpoint(),entry.snapshot);
    return views.map(view=> {
      const retained = entry.materialViews.find(value=>value.reference.id === view.reference.id);
      if (retained) return retained;
      const saved = immutable(view); entry.materialViews.push(saved); return saved;
    });
  }

  private async executeCommandObservation(entry: Execution, input: Parameters<RunProcessManager["observeCommand"]>[0]): Promise<CommandObservation> {
    const {request} = input;
    if (!["snapshot","change","outcome","settled"].includes(request.until) || !Number.isSafeInteger(request.waitMs) || request.waitMs < 0 || request.waitMs > 30_000 ||
        !Number.isFinite(Date.parse(input.deadlineAt)) || (request.until !== "change" && request.after !== undefined)) throw new ProcessManagerError("process_observation_input_invalid");
    const before = request.until === "change" ? entry.commandObservations.find(value=>value.id === request.after) : undefined;
    if (request.until === "change" && !before) throw new ProcessManagerError("process_observation_basis_invalid");
    const basis = before ? commandObservationBasis(before.snapshot,before.materials) : null;
    const ready = () => request.until === "snapshot" || request.until === "outcome" && entry.snapshot.outcome !== null ||
      request.until === "settled" && entry.snapshot.phase === "settled" || request.until === "change" &&
      commandObservationBasis(entry.snapshot,entry.output ? describeProcessOutput(entry.output.checkpoint(),entry.snapshot) : []) !== basis;
    const terminal = () => entry.snapshot.phase === "unresolved" || entry.snapshot.phase === "settled";
    const effectiveWaitMs = request.until === "snapshot" ? 0 : Math.min(request.waitMs,Math.max(0,Date.parse(input.deadlineAt)-Date.parse(this.now())));
    const observationId = `${input.executionId}:observation:${++entry.observationSequence}`;
    const details = {observationId,invocationId:input.invocationId,waitMs:effectiveWaitMs,requestedWaitMs:request.waitMs,commandCondition:request};
    this.publish(entry,"observation_started",details);
    const start = performance.now();
    try {await this.wait(entry,input.signal,effectiveWaitMs,()=>ready() || terminal());}
    catch (error) {this.publish(entry,"observation_cancelled",details);throw error;}
    input.signal.throwIfAborted();
    const result: CommandObservation = immutable({id:observationId,invocationId:input.invocationId,request:structuredClone(request),
      snapshot:entry.snapshot,materials:this.outputMaterials(entry),effectiveWaitMs,elapsedWaitMs:Math.max(0,performance.now()-start),
      returnReason:request.until === "snapshot" ? "immediate_snapshot" : entry.snapshot.phase === "unresolved" ? "process_unresolved" :
        ready() ? "condition_satisfied" : terminal() ? "process_settled" : "observation_wait_limit"});
    entry.commandObservations.push(result);
    this.publish(entry,"observation_returned",{...details,commandObservation:result});
    await this.flush(entry);
    return result;
  }

  async stop(identity: CanonicalProcessIdentity, requestId?: string): Promise<ProcessSnapshot> {
    const entry = this.find(identity.runId, identity.taskId);
    if (entry.snapshot.process?.startFingerprint !== identity.startFingerprint || entry.snapshot.process.processId !== identity.processId) throw new ProcessManagerError("process_task_identity_mismatch", entry.snapshot);
    if (entry.snapshot.containment.disposition === "empty") { await this.flush(entry); return entry.snapshot; }
    if (entry.recovered) throw new ProcessManagerError("process_control_unavailable_after_recovery", entry.snapshot);
    await this.requestTermination(entry, "model_stop", requestId);
    await this.flush(entry);
    return entry.snapshot;
  }

  async finalizeRun(context: { runId: string; deadlineAt: string; signal: AbortSignal }): Promise<ProcessCleanupSummary> {
    this.closedRuns.add(context.runId);
    const entries = [...this.executions.values()].filter((entry) => entry.input.runId === context.runId);
    await Promise.all(entries.map(async (entry) => {
      if (!entry.recovered && entry.snapshot.containment.disposition !== "empty") void this.requestTermination(entry, "run_finalization");
      if (!entry.recovered) try { await this.wait(entry, context.signal, Math.max(0, Date.parse(context.deadlineAt) - Date.parse(this.now())), () => entry.snapshot.phase === "settled"); } catch {}
      this.publish(entry,"finalized",{cleanupConfirmed:entry.snapshot.phase === "settled" && entry.snapshot.output.persistence !== "failed"});
      await this.flush(entry);
    }));
    return immutable({ runId: context.runId,
      completed: entries.every((entry) => entry.snapshot.phase === "settled" && entry.snapshot.output.persistence !== "failed"),
      executions: entries.map((entry) => entry.snapshot) });
  }

  async restoreRun(runId: string): Promise<void> {
    if (!this.options.records) throw new ProcessRecordError(runId);
    if ([...this.executions.values()].some(entry => entry.input.runId === runId)) throw new ProcessManagerError("process_run_already_loaded");
    const checkpoints = await this.options.records.readProcesses(runId);
    for (const saved of checkpoints) for (const fact of saved.notifications) {
      this.notificationSequence = Math.max(this.notificationSequence, fact.sequence);
    }
    for (const saved of checkpoints) {
      if (saved.input.runId !== runId || this.executions.has(saved.input.executionId)) throw new ProcessRecordError(saved.input.executionId);
      const interrupted = saved.snapshot.phase !== "settled";
      const snapshot: ProcessSnapshot = interrupted ? immutable({...saved.snapshot, revision: saved.snapshot.revision + 1,
        phase: saved.launchIntent ? "unresolved" : "settled",
        outcome: saved.snapshot.outcome ?? (saved.launchIntent ? "unknown" : "failed"),
        containment: saved.snapshot.containment.disposition === "empty" ? saved.snapshot.containment
          : {disposition: saved.launchIntent ? "unknown" : "empty", confirmedAt: saved.launchIntent ? null : this.now()},
        output: {...saved.snapshot.output, capture: saved.snapshot.output.capture === "open" ? "incomplete" : saved.snapshot.output.capture,
          persistence: saved.output ? "complete" : "failed", omittedBytes: saved.snapshot.output.capture === "open" ? null : saved.snapshot.output.omittedBytes},
        cwdDisposition: saved.snapshot.cwdDisposition === "eligible" ? "unavailable" : saved.snapshot.cwdDisposition,
        limitations: [...saved.snapshot.limitations, saved.launchIntent ? "process_host_interrupted_control_unavailable" : "process_launch_not_dispatched"]}) : saved.snapshot;
      const input: ManagedProcessStart = {...saved.input, runSignal: new AbortController().signal,
        ...(saved.input.origin ? {origin: saved.input.origin} : {origin: undefined}),
        displayCommand: saved.input.displayCommand ?? undefined};
      const entry: Execution = {input, snapshot, checkpointRevision: saved.revision, launchIntent: saved.launchIntent,
        recovered: true, persistence: Promise.resolve(), persistenceFailure: null, observations: [...saved.observations], commandObservations: [...saved.commandObservations], materialViews: [...saved.materialViews],
        output: saved.output ? ProcessOutputStore.restore(saved.output, saved.input.paths) : null,
        handle: null, launchFinished: true, timer: null, runDeadlineTimer: null, terminationTimer: null,
        listeners: new Set(), launchAbort: new AbortController(), abort: () => {}, settled: Promise.resolve(), resolve: () => {},
        closePromise: null, outputClosePromise: Promise.resolve(), cwdPromise: Promise.resolve(), stopPromise: null,
        observationSequence: saved.observationSequence, initialObservation: saved.initialSnapshot !== null,
        initialSnapshot: saved.initialSnapshot, initialDelivery: saved.initialDelivery, deliveryCursor: saved.deliveryCursor ?? undefined,
        announcedOutputCursor: saved.announcedOutputCursor ?? undefined,
        deliveryState: saved.deliveryState, lastOutputNotification: 0};
      this.executions.set(input.executionId, entry);
      this.revision++;
      this.committedNotifications.set(input.executionId, saved.notifications);
      const facts = this.notifications.get(runId) ?? [];
      facts.push(...saved.notifications);
      facts.sort((a,b) => a.sequence - b.sequence);
      this.notifications.set(runId, facts);
      if (interrupted) {
        this.notifyInput(entry, "process_reconciled");
        this.publish(entry, "reconciled");
        await this.flush(entry);
      }
    }
  }

  async flushRun(runId: string): Promise<void> {
    for (const entry of this.executions.values()) if (entry.input.runId === runId) await this.flush(entry);
  }

  private async flush(entry: Execution): Promise<void> {
    await entry.persistence;
    if (entry.persistenceFailure) throw entry.persistenceFailure;
  }

  private retain(entry: Execution): void {
    const records = this.options.records;
    if (!records || entry.persistenceFailure) return;
    const source = entry.input;
    const checkpoint: ProcessCheckpoint = structuredClone({version: 4, revision: ++entry.checkpointRevision,
      input: {runId: source.runId, executionId: source.executionId, actionId: source.actionId, origin: source.origin ?? null,
        environmentId: source.environmentId, executable: source.executable, args: source.args, cwd: source.cwd,
        environment: source.environment, timeoutMs: source.timeoutMs, deadlineAt: source.deadlineAt, paths: source.paths,
        maximumOutputBytes: source.maximumOutputBytes, background: source.background, displayCommand: source.displayCommand ?? null},
      launchIntent: entry.launchIntent, snapshot: entry.snapshot, output: entry.output?.checkpoint() ?? null,
      observationSequence: entry.observationSequence, initialSnapshot: entry.initialSnapshot, observations: entry.observations,
      commandObservations: entry.commandObservations, materialViews: entry.materialViews,
      initialDelivery: entry.initialDelivery, deliveryCursor: entry.deliveryCursor ?? null, deliveryState: entry.deliveryState,
      announcedOutputCursor: entry.announcedOutputCursor ?? null,
      notifications: (this.notifications.get(source.runId) ?? []).filter(fact => fact.source.id === source.executionId)});
    entry.persistence = entry.persistence.then(async () => {
      if (entry.persistenceFailure) return;
      await records.commitProcess(checkpoint);
      this.committedNotifications.set(source.executionId, immutable(checkpoint.notifications));
    }).catch(error => { entry.persistenceFailure = new ProcessRecordError(source.executionId, {cause: error}); });
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
      if (entry.snapshot.rootExit !== null) return;
      if (entry.timer !== null) clearTimeout(entry.timer);
      const finishedAt = this.now();
      const reason = entry.snapshot.termination?.reason;
      const outcome = reason === "execution_timeout" || reason === "run_deadline" ? "timed_out" :
        reason && reason !== "backend_failure" ? "cancelled" : event.code === 0 ? "succeeded" : "failed";
      this.change(entry, { rootExit: { code: event.code, signal: event.signal, observedAt: finishedAt }, outcome, finishedAt });
      void this.consumeCwd(entry);
      this.notifyInput(entry, "command_completed");
      this.publish(entry, "root_exit");
    } else if (event.kind === "scope_members") {
      this.publish(entry, "scope_members", {scopeMembers: event.snapshot});
    } else if (event.kind === "scope_empty") {
      if (entry.timer !== null) clearTimeout(entry.timer);
      if (entry.runDeadlineTimer !== null) clearTimeout(entry.runDeadlineTimer);
      if (entry.terminationTimer !== null) clearTimeout(entry.terminationTimer);
      this.change(entry, { phase: "draining", containment: { disposition: "empty", confirmedAt: this.now() } });
      this.publish(entry, "scope_empty"); this.maybeSettle(entry);
    } else if (event.kind === "output_closed") {
      this.change(entry, { output: { ...entry.snapshot.output, capture: event.incomplete ? "incomplete" : "closed" } });
      void this.closeOutput(entry).then(() => this.maybeSettle(entry));
      this.maybeSettle(entry);
    } else {
      this.change(entry, { phase: "unresolved", limitations: [...entry.snapshot.limitations, event.code],
        containment: { disposition: entry.snapshot.containment.disposition === "empty" ? "empty" : "unknown", confirmedAt: entry.snapshot.containment.confirmedAt }, outcome: entry.snapshot.outcome ?? "unknown" });
      this.notifyInput(entry, "process_resource_failure");
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
      if (entry.runDeadlineTimer !== null) clearTimeout(entry.runDeadlineTimer);
      if (entry.terminationTimer !== null) clearTimeout(entry.terminationTimer);
      entry.input.runSignal.removeEventListener("abort", entry.abort);
      await this.closeOutput(entry);
      await this.consumeCwd(entry);
      try { await entry.handle?.close(); } catch { this.change(entry, { limitations: [...entry.snapshot.limitations, "process_backend_close_failed"] }); }
      this.refreshOutput(entry);
      this.change(entry, { phase: "settled", finishedAt: entry.snapshot.finishedAt ?? this.now(), outcome: entry.snapshot.outcome ?? "unknown" });
      this.notifyInput(entry, "process_settled");
      this.publish(entry, "settled"); entry.resolve();
      const settled = [...this.executions.values()].filter((candidate) => candidate.snapshot.phase === "settled" && candidate !== entry &&
        (candidate.input.origin === undefined || candidate.initialDelivery !== null || this.closedRuns.has(candidate.input.runId)) &&
        (candidate.snapshot.output.persistence !== "failed" || this.closedRuns.has(candidate.input.runId)));
      while (!this.options.records && settled.length >= this.options.maximumSettled) {
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

  private closeOutput(entry: Execution): Promise<void> {
    if (entry.outputClosePromise !== null) return entry.outputClosePromise;
    entry.outputClosePromise = (async () => {
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
      this.refreshOutput(entry);
      this.change(entry, { output: { ...entry.snapshot.output, persistence } });
      this.notifyInput(entry, persistence === "failed" || entry.snapshot.output.capture === "incomplete"
        ? "process_output_limited" : "process_output_completed");
      this.publish(entry, "output_settled");
    })();
    return entry.outputClosePromise;
  }

  private consumeCwd(entry: Execution): Promise<void> {
    return entry.cwdPromise ??= (async () => {
      let finalCwd: string | null = null;
      try { finalCwd = await entry.input.consumeFinalCwd?.() ?? null; }
      catch { this.change(entry, { limitations: [...entry.snapshot.limitations, "process_final_cwd_unavailable"] }); }
      this.change(entry, { finalCwd });
    })();
  }

  private notifyInput(entry: Execution, kind: string, publish = true): ProcessInputNotification | undefined {
    if (entry.initialDelivery === null || this.closedRuns.has(entry.input.runId)) return;
    const snapshot = entry.snapshot;
    const state = deliveryState(snapshot);
    const newOutput = entry.output?.hasUnread(entry.announcedOutputCursor) ?? false;
    if (entry.deliveryState === state && !newOutput) return;
    // Availability is not read coverage: old unshown pages remain explicitly retrievable.
    const previousCursor = entry.announcedOutputCursor ?? null;
    const selected = newOutput ? entry.output?.readModelOutput(entry.announcedOutputCursor) : undefined;
    const capture = selected && [selected.stdout, selected.stderr].some(stream =>
      stream.text.length > 0 || stream.byteEnd > stream.byteStart) ? selected : undefined;
    // Segment text is diagnostic detail; duplicating it would double the model payload.
    const stream = (value: NonNullable<typeof capture>["stdout"]) => {
      const {segments: _segments, ...projection} = value;
      return projection;
    };
    const fact: ProcessInputNotification = immutable({runId: entry.input.runId, sequence: ++this.notificationSequence,
      source: {owner: "helarc-command", kind, id: entry.input.executionId, revision: String(snapshot.revision)},
      occurredAt: this.now(), interpretation: {kind: "notification", purpose: "later_outcome", author: "capability", originRunId: entry.input.runId},
      data: {kind, task_id: entry.input.executionId, origin: snapshot.origin,
        initial_cwd: snapshot.initialCwd, final_cwd: snapshot.finalCwd, session_cwd: snapshot.sessionCwd, cwd_disposition: snapshot.cwdDisposition,
        command: entry.input.displayCommand?.command.slice(0, 4096) ?? null,
        command_truncated: (entry.input.displayCommand?.command.length ?? 0) > 4096,
        snapshot_revision: snapshot.revision, phase: snapshot.phase, output_materials: this.outputMaterials(entry),
        outcome: snapshot.outcome, rootExit: snapshot.rootExit, termination: snapshot.termination,
        containment: snapshot.containment, output: snapshot.output, limitations: snapshot.limitations.slice(0, 16).map(value => value.slice(0, 256)),
        limitations_truncated: snapshot.limitations.length > 16 || snapshot.limitations.some(value => value.length > 256),
        ...(capture ? {capture: {stdout: stream(capture.stdout), stderr: stream(capture.stderr),
          previousCursor, nextCursor: capture.nextCursor, hasMore: capture.hasMore}} : {})}});
    const facts = this.notifications.get(entry.input.runId) ?? [];
    facts.push(fact);
    this.notifications.set(entry.input.runId, facts);
    // This reserves an immutable payload; Runtime's receipt, not this cursor, records acceptance.
    entry.deliveryState = state;
    entry.deliveryCursor = capture?.nextCursor ?? entry.deliveryCursor;
    entry.announcedOutputCursor = entry.output?.captureCursor() ?? entry.announcedOutputCursor;
    if (publish) this.publish(entry, "input_notified", {notification: fact,
      outputDelivery: {availableCursor: entry.announcedOutputCursor ?? null, presentedCursor: entry.deliveryCursor ?? null}});
    return fact;
  }

  private requestTermination(entry: Execution, reason: ProcessTerminationReason, requestId?: string): Promise<void> {
    if (entry.recovered) return Promise.resolve();
    if (entry.snapshot.phase === "settled") return Promise.resolve();
    if (entry.stopPromise !== null) return entry.stopPromise;
    if (entry.snapshot.termination === null) {
      this.change(entry, { phase: entry.snapshot.containment.disposition === "empty" ? "draining" : "stopping",
        termination: { reason, requestedAt: this.now(), method: "none" } });
      if (entry.snapshot.rootExit !== null) this.notifyInput(entry, "process_scope_termination");
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
        this.change(entry, { phase: "unresolved", outcome: entry.snapshot.outcome ?? "unknown", limitations: [...entry.snapshot.limitations, "process_cleanup_unconfirmed"] });
        this.notifyInput(entry, "process_cleanup_unconfirmed");
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
    if (!["output", "scope_members"].includes(kind)) this.retain(entry);
    const fact: ProcessExecutionFact = immutable({ ...extra, kind, sequence: ++this.sequence, activationId: this.scopeId,
      occurredAt: this.now(), snapshot: entry.snapshot, ...(entry.output ? {outputPositions:entry.output.positions} : {}) });
    const emit = () => { try { void Promise.resolve(this.options.observer?.(fact)).catch(() => {}); } catch {} };
    if (this.options.records && kind !== "output" && kind !== "scope_members") {
      void entry.persistence.then(() => { if (!entry.persistenceFailure) emit(); });
    } else emit();
  }
}

function deliveryState(snapshot: ProcessSnapshot): string {
  return JSON.stringify({phase: snapshot.phase, outcome: snapshot.outcome, rootExit: snapshot.rootExit,
    termination: snapshot.termination, containment: snapshot.containment, output: snapshot.output, limitations: snapshot.limitations,
    finalCwd: snapshot.finalCwd, sessionCwd: snapshot.sessionCwd, cwdDisposition: snapshot.cwdDisposition});
}

export class ProcessManagerError extends Error {
  constructor(readonly code: string, readonly snapshot: ProcessSnapshot | null = null, readonly admission: Readonly<Record<string, string | number>> | null = null) {
    super(admission === null ? code : `${code}: ${admission.activeCount} active commands; maximum ${admission.maximumActive} in manager ${admission.managerId}. The command was not started.`);
    this.name = "ProcessManagerError";
  }
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
