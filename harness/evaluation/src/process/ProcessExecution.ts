import type { EvaluationRecordRef } from "../contract/EvaluationPrimitives.js";
import type { EvaluationDataValue } from "../contract/EvaluationData.js";
import { createEvaluationProcessPlan, projectProcessTargetInput, reviewProcessStartingState, sameProcessValue,
  type EvaluationProcessPlan, type ProcessStartingStateReceipt } from "./ProcessDefinition.js";
import { ProcessResourceScope, type ProcessCleanupReceipt } from "./ProcessResourceScope.js";
import {assertProcessCaptureBinding} from "./ProcessCapture.js";
import type {EvaluationCapture} from "../capture/EvaluationCapture.js";

export interface ProcessTargetResult {
  readonly status: "completed" | "failed" | "interrupted";
  readonly bindings: EvaluationRecordRef;
  readonly executionRef: EvaluationRecordRef;
  readonly evidence: readonly EvaluationRecordRef[];
  readonly reason: string | null;
}
export interface ProcessCaptureResult {
  readonly capture: EvaluationCapture;
  readonly ref: EvaluationRecordRef;
  readonly status: "complete" | "partial" | "failed";
  readonly sources: readonly {
    readonly owner: string;
    readonly status: "complete" | "partial" | "unavailable";
    readonly refs: readonly EvaluationRecordRef[];
    readonly reason: string | null;
  }[];
}
export interface ProcessEvaluationConclusion {
  readonly claim: string;
  readonly verdict: "conforms" | "violated" | "insufficient_evidence" | "not_applicable";
  readonly evidence: readonly EvaluationRecordRef[];
  readonly explanation: string;
}
export interface ProcessExecutionRecord {
  readonly revision: number;
  readonly plan: EvaluationProcessPlan;
  readonly phase: "registered" | "preparing" | "running" | "capturing" | "reporting" | "finished";
  readonly execution: ProcessExecutionReport["execution"] | null;
  readonly startingReceipt: ProcessStartingStateReceipt | null;
  readonly target: ProcessTargetResult | null;
  readonly capture: ProcessCaptureResult | null;
  readonly cleanup: ProcessCleanupReceipt | null;
  readonly failure: {readonly stage: "preparation" | "execution" | "capture" | "assessment"; readonly reason: string} | null;
  readonly conclusions: readonly ProcessEvaluationConclusion[];
  readonly failures: readonly {readonly stage: string; readonly reason: string}[];
}
export interface ProcessExecutionStore {
  claim(): Promise<{release(): Promise<void>}>;
  load(): Promise<ProcessExecutionRecord | null>;
  commit(expectedRevision: number | null, record: ProcessExecutionRecord): Promise<void>;
}
export interface ProcessExecutionReport {
  readonly trialRef: EvaluationRecordRef;
  readonly recordRevision: number;
  readonly execution: "completed" | "interrupted" | "failed" | "timed_out" | "cancelled";
  readonly capture: ProcessCaptureResult | null;
  readonly cleanup: ProcessCleanupReceipt;
  readonly conclusions: readonly ProcessEvaluationConclusion[];
  readonly failures: readonly {readonly stage: string; readonly reason: string}[];
  readonly limitations: readonly string[];
}
export interface ProcessExecutionPorts {
  readonly store: ProcessExecutionStore;
  readonly environment: {
    prepare(input: EvaluationDataValue, scope: ProcessResourceScope, signal: AbortSignal): Promise<ProcessStartingStateReceipt>;
    verify(receipt: ProcessStartingStateReceipt, scope: ProcessResourceScope, signal: AbortSignal): Promise<ProcessStartingStateReceipt>;
  };
  readonly target: {
    invoke(input: EvaluationDataValue, receipt: ProcessStartingStateReceipt, scope: ProcessResourceScope, signal: AbortSignal): Promise<ProcessTargetResult>;
    cancel(receipt: ProcessStartingStateReceipt | null): Promise<void>;
  };
  readonly capture: (record: ProcessExecutionRecord, scope: ProcessResourceScope, signal: AbortSignal) => Promise<ProcessCaptureResult>;
  readonly assess: (capture: ProcessCaptureResult | null, expectationRefs: readonly EvaluationRecordRef[], scope: ProcessResourceScope, signal: AbortSignal) => Promise<readonly ProcessEvaluationConclusion[]>;
  readonly saveReport: (report: ProcessExecutionReport, scope: ProcessResourceScope, signal: AbortSignal) => Promise<EvaluationRecordRef>;
}
export interface ProcessExecutionControl {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly captureTimeoutMs: number;
}
export interface ProcessExecutionOutcome {
  readonly report: ProcessExecutionReport;
  readonly savedReport: EvaluationRecordRef | null;
  readonly reportFailure: string | null;
  readonly reportCleanup: ProcessCleanupReceipt | null;
}

/** Evaluation coordination only; the target owns all task scheduling and recovery. */
export class EvaluationProcessExecution {
  constructor(readonly ports: ProcessExecutionPorts) {}
  async run(input: EvaluationProcessPlan, control: ProcessExecutionControl): Promise<ProcessExecutionOutcome> {
    const ownership = await this.ports.store.claim();
    try {return await this.#run(input, control);}
    finally {await ownership.release();}
  }
  async #run(input: EvaluationProcessPlan, control: ProcessExecutionControl): Promise<ProcessExecutionOutcome> {
    for (const limit of [control.timeoutMs, control.cleanupTimeoutMs, control.captureTimeoutMs])
      if (!Number.isFinite(limit) || limit <= 0) throw new TypeError("Process execution requires positive finite bounds");
    const plan = createEvaluationProcessPlan(input);
    let record = await this.ports.store.load();
    if (record && !sameProcessValue(record.plan, plan)) throw new Error("process_trial_binding_mismatch");
    const commit = async (changes: Partial<ProcessExecutionRecord>) => {
      const expected = record?.revision ?? null;
      const next: ProcessExecutionRecord = {...record!, ...changes, plan, revision: (expected ?? 0) + 1};
      await this.ports.store.commit(expected, next); record = next;
    };
    if (!record) await commit({phase: "registered", execution: null, startingReceipt: null, target: null, capture: null, cleanup: null, failure: null, failures: [], conclusions: []});
    if (record!.cleanup?.status === "quarantined") throw new Error("process_trial_quarantined_requires_owner_reconciliation");
    const scope = new ProcessResourceScope();
    const cancellation = new AbortController();
    let interrupt: "cancelled" | "timed_out" | null = null;
    let interruptResolve: (() => void) | undefined;
    const interrupted = new Promise<void>(resolve => { interruptResolve = resolve; });
    const stop = (reason: "cancelled" | "timed_out") => {
      if (interrupt) return;
      interrupt = reason; scope.stopAdmission(); cancellation.abort(reason); interruptResolve!();
    };
    const abort = () => stop("cancelled");
    control.signal.addEventListener("abort", abort, {once: true});
    if (control.signal.aborted) abort();
    const timer = setTimeout(() => stop("timed_out"), control.timeoutMs);
    let execution: ProcessExecutionReport["execution"] = "failed";
    const failures: {stage: string; reason: string}[] = [...record!.failures];
    const inputProjection = projectProcessTargetInput(plan);
    let work: Promise<void> | null = null;
    try {
      if (record!.phase === "finished" || record!.phase === "reporting") {
        execution = record!.execution ?? "failed";
      } else if (!interrupt) {
        let settled = false;
        await scope.acquire("process-target", "target", async () => ({id: "process-target", kind: "target", close: async () => {
          if (!settled) await this.ports.target.cancel(record!.startingReceipt);
          await work;
        }}));
        if (cancellation.signal.aborted) throw new Error("process_interrupted_before_work");
        work = (async () => {
          if (record!.target?.status === "interrupted") await commit({capture: null, conclusions: [], cleanup: null});
          if (!record!.startingReceipt) {
            await commit({phase: "preparing"});
            const receipt = await this.ports.environment.prepare(inputProjection, scope, cancellation.signal);
            if (cancellation.signal.aborted) return;
            const reasons = reviewProcessStartingState(plan, receipt);
            if (reasons.length) throw new Error(reasons.join(","));
            await commit({startingReceipt: receipt, phase: "running"});
          } else {
            const receipt = await this.ports.environment.verify(record!.startingReceipt, scope, cancellation.signal);
            if (!sameProcessValue(receipt, record!.startingReceipt) || reviewProcessStartingState(plan, receipt).length)
              throw new Error("process_original_bindings_unavailable");
          }
          if (cancellation.signal.aborted) return;
          if (!record!.target || record!.target.status === "interrupted") {
            const result = await this.ports.target.invoke(inputProjection, record!.startingReceipt!, scope, cancellation.signal);
            if (cancellation.signal.aborted) return;
            if (!sameProcessValue(result.bindings, record!.startingReceipt!.bindings)) throw new Error("process_target_binding_mismatch");
            if (record!.target && !sameProcessValue(result.executionRef, record!.target.executionRef)) throw new Error("process_target_execution_mismatch");
            await commit({target: result, phase: result.status === "interrupted" ? "running" : "capturing"});
          }
        })().catch(async error => {
          if (!cancellation.signal.aborted) await commit({failure: {stage: record!.startingReceipt ? "execution" : "preparation", reason: String(error)}, phase: "capturing"});
        }).finally(() => { settled = true; });
        await Promise.race([work, interrupted]);
        execution = interrupt ?? (record!.failure ? "failed" : record!.target?.status ?? "failed");
      } else execution = interrupt;
    } catch (error) { failures.push({stage: "execution", reason: String(error)}); execution = interrupt ?? "failed"; }
    finally { clearTimeout(timer); control.signal.removeEventListener("abort", abort); }

    // Target resources close before capture; capture owns separate read-only resources.
    const cleanup = await scope.close(control.cleanupTimeoutMs);
    if (cleanup.status === "quarantined") failures.push({stage: "cleanup", reason: "owned_resources_unconfirmed"});
    if (record!.failure) failures.push(record!.failure);
    if (record!.target?.status === "failed" && !failures.some(failure => failure.stage === "execution"))
      failures.push({stage: "execution", reason: record!.target.reason ?? "target_execution_failed_without_reason"});
    let captureCleanup: ProcessCleanupReceipt = {status: "cleaned", resources: []};
    if (cleanup.status === "quarantined") failures.push({stage: "capture", reason: "target_resources_not_quiescent"});
    if (cleanup.status === "cleaned" && !record!.capture && record!.phase !== "finished") {
      const capturedRecord = record!;
      const result = await runOwnedReadPhase("capture", (scope, signal) => this.ports.capture(capturedRecord, scope, signal), control);
      captureCleanup = result.cleanup;
      if ("value" in result.outcome) {
        try {assertProcessCaptureBinding(plan, result.outcome.value); await commit({capture: result.outcome.value});}
        catch (error) {failures.push({stage: "capture", reason: String(error)});}
      }
      else failures.push({stage: "capture", reason: String(result.outcome.error)});
    }
    let conclusions = record!.conclusions;
    let assessmentCleanup: ProcessCleanupReceipt = {status: "cleaned", resources: []};
    if (record!.capture && !conclusions.length && record!.phase !== "finished") {
      const capture = record!.capture;
      const result = await runOwnedReadPhase("assessment", (scope, signal) => this.ports.assess(capture, plan.expectationRefs, scope, signal), control);
      assessmentCleanup = result.cleanup;
      if ("value" in result.outcome) {
        const values = result.outcome.value;
        if (values.some(value => !plan.claimRefs.some(ref => ref.id === value.claim) ||
          !["conforms", "violated", "insufficient_evidence", "not_applicable"].includes(value.verdict) ||
          !value.explanation?.trim() || (value.verdict === "conforms" && value.evidence.length === 0)) || new Set(values.map(value => value.claim)).size !== values.length)
          failures.push({stage: "assessment", reason: "process_invalid_or_duplicate_claim"});
        else conclusions = plan.claimRefs.map(ref => values.find(value => value.claim === ref.id) ?? {
          claim: ref.id, verdict: "insufficient_evidence", evidence: [], explanation: "No independent judgment was returned for the declared claim",
        });
      }
      else failures.push({stage: "assessment", reason: String(result.outcome.error)});
    }
    if (!conclusions.length) conclusions = plan.claimRefs.map(ref => ({claim: ref.id, verdict: "insufficient_evidence",
      evidence: [], explanation: "Independent assessment was unavailable or invalid"}));
    const combined: ProcessCleanupReceipt = {status: [cleanup, captureCleanup, assessmentCleanup].every(value => value.status === "cleaned") ? "cleaned" : "quarantined",
      resources: [...cleanup.resources, ...captureCleanup.resources, ...assessmentCleanup.resources]};
    await commit({execution, cleanup: combined, conclusions, failures, phase: execution === "interrupted" ? "running" : "reporting"});
    const report: ProcessExecutionReport = {trialRef: plan.trial.ref, recordRevision: record!.revision, execution,
      capture: record!.capture, cleanup: combined, conclusions, failures,
      limitations: [...plan.evidenceLimitations, ...plan.futureStimuli.map(value => `stimulus_delivery_requires_target_evidence:${value.id}`)]};
    let reportCleanup: ProcessCleanupReceipt | null = null;
    try {
      const persisted = await runOwnedReadPhase("report", (scope, signal) => this.ports.saveReport(report, scope, signal), control);
      reportCleanup = persisted.cleanup;
      if (persisted.cleanup.status === "quarantined") await commit({cleanup: {status: "quarantined", resources: [...combined.resources, ...persisted.cleanup.resources]}});
      if ("error" in persisted.outcome) return {report, savedReport: null, reportFailure: String(persisted.outcome.error), reportCleanup};
      const savedReport = persisted.outcome.value;
      if (execution !== "interrupted") await commit({phase: "finished"});
      return {report, savedReport, reportFailure: null, reportCleanup};
    } catch (error) { return {report, savedReport: null, reportFailure: String(error), reportCleanup}; }
  }
}

async function runOwnedReadPhase<T>(id: string, run: (scope: ProcessResourceScope, signal: AbortSignal) => Promise<T>, control: ProcessExecutionControl) {
  const scope = new ProcessResourceScope(), cancellation = new AbortController();
  let work: Promise<{value: T} | {error: unknown}> | undefined, settled = false;
  await scope.acquire(`process-${id}`, id, async () => ({id: `process-${id}`, kind: id, close: async () => {
    if (!settled) cancellation.abort(); await work;
  }}));
  work = Promise.resolve().then(() => run(scope, cancellation.signal)).then(value => ({value}), error => ({error})).finally(() => {settled = true;});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: {value: T} | {error: unknown};
  try {
    outcome = await Promise.race([work, new Promise<{error: unknown}>(resolve => {
      timer = setTimeout(() => {scope.stopAdmission(); cancellation.abort(); resolve({error: new Error(`process_${id}_timeout`)});}, control.captureTimeoutMs);
    })]);
  } finally {if (timer) clearTimeout(timer);}
  const cleanup = await scope.close(control.cleanupTimeoutMs);
  return {outcome, cleanup};
}
