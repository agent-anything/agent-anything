import {describe, expect, it, vi} from "vitest";
import {createEvaluationProcessPlan, processStartingStateFacets, projectProcessTargetInput, reviewProcessStartingState,
  assertProcessBranchIsolation, selectProcessStimuli, EvaluationProcessExecution, ProcessResourceScope, assembleProcessCapture, EvaluationProcessStimulusDelivery,
  type EvaluationProcessPlan, type ProcessStartingStateReceipt, type ProcessExecutionPorts, type ProcessExecutionRecord} from "./index.js";

const ref = (id: string) => ({id, revision: "1"});
function plan(id = "trial"): EvaluationProcessPlan {
  return createEvaluationProcessPlan({trial: {ref: ref(id), campaignRef: ref("campaign"), targetSnapshotRef: ref("target"),
    caseRef: ref("case"), repetitionOrdinal: 1, seed: "fixed", pairingKey: "pair", environmentProtocolRef: ref("environment"),
    createdAt: "2026-11-01T00:00:00.000Z", metadata: {}}, mode: "actual_process",
    startingState: {ref: ref("start"), construction: ref("supported-construction"), boundary: "task_start",
      entries: processStartingStateFacets.map(facet => ({facet, owner: "target", disposition: "empty", evidence: []}))},
    branch: {trialId: id, branchId: id, workspaceId: id, storageId: id, authorityId: id, activityNamespace: id, commonHistory: ref("common")},
    targetInput: {prompt: "do work"}, variants: [], expectationRefs: [ref("private-reference-answer")], claimRefs: [ref("effect-once")], captureSources: ["execution"],
    captureBounds: {maxBytesPerSource: 1048576, maxRecordsPerSource: 1000},
    futureStimuli: [{id: "later", condition: {owner: "run", fact: "effect_accepted", subject: "root"}, input: "private future question"}], capturePolicyRef: ref("capture-policy"), evidenceLimitations: ["controlled_target_only"]});
}
function receipt(p = plan()): ProcessStartingStateReceipt {
  return {startingStateRef: p.startingState.ref, branch: p.branch, bindings: ref("original-bindings"),
    entries: p.startingState.entries.map(entry => ({facet: entry.facet, owner: entry.owner, disposition: "confirmed_empty", sourceEvidence: entry.evidence, evidence: []}))};
}
function ports(p = plan()) {
  let saved: ProcessExecutionRecord | null = null;
  let claimed = false;
  const value: ProcessExecutionPorts = {
    store: {claim: async () => {if (claimed) throw new Error("trial_already_owned"); claimed = true; return {release: async () => {claimed = false;}};},
      load: async () => saved, commit: async (expected, next) => {expect(saved?.revision ?? null).toBe(expected); saved = structuredClone(next);}},
    environment: {prepare: vi.fn(async () => receipt(p)), verify: vi.fn(async r => r)},
    target: {invoke: vi.fn(async () => ({status: "completed", bindings: receipt(p).bindings, executionRef: ref("execution"), evidence: [ref("effect")], reason: null})), cancel: vi.fn(async () => {})},
    capture: vi.fn(async () => assembleProcessCapture({plan: p, ref: ref("capture"), startedAt: p.trial.createdAt, completedAt: p.trial.createdAt,
      sources: [{owner: "execution", status: "complete", refs: [ref("effect")], reason: null}]})),
    assess: vi.fn(async () => [{claim: "effect-once", verdict: "conforms", evidence: [ref("effect")], explanation: "Independent count"}]),
    saveReport: vi.fn(async () => ref("report")),
  };
  return value;
}
const control = () => ({signal: new AbortController().signal, timeoutMs: 2000, cleanupTimeoutMs: 100, captureTimeoutMs: 100});

describe("process starting states and information isolation", () => {
  it("requires explicit coverage and prevents unknown work from becoming an empty start", () => {
    const p = plan();
    expect(() => createEvaluationProcessPlan({...p, startingState: {...p.startingState, entries: p.startingState.entries.slice(1)}})).toThrow(/every responsibility/);
    const unknown = createEvaluationProcessPlan({...p, startingState: {...p.startingState, entries: p.startingState.entries.map(entry => entry.facet === "unfinished_work" ? {...entry, disposition: "unavailable"} : entry)}});
    expect(reviewProcessStartingState(unknown, receipt(p))).toContain("starting_unavailable:unfinished_work");
  });
  it("requires independent branches, while preserving the declared common history", () => {
    expect(() => assertProcessBranchIsolation([plan("a").branch, plan("b").branch])).not.toThrow();
    expect(() => assertProcessBranchIsolation([plan("a").branch, {...plan("b").branch, authorityId: "a"}])).toThrow(/authorityId/);
    expect(reviewProcessStartingState(plan(), {...receipt(), branch: plan("other").branch})).toContain("starting_identity_mismatch");
  });
  it("withholds expectations and future questions until an evidenced condition occurs", () => {
    const p = plan(), text = JSON.stringify(projectProcessTargetInput(p));
    expect(text).not.toContain("private-reference-answer"); expect(text).not.toContain("private future question");
    expect(selectProcessStimuli(p, [], [])).toEqual([]);
    const facts = [{owner: "run", fact: "effect_accepted", subject: "root", evidence: ref("acceptance")}];
    expect(selectProcessStimuli(p, facts, [])).toEqual([{id: "later", input: "private future question", basis: ref("acceptance")}]);
    expect(selectProcessStimuli(p, facts, ["later"])).toEqual([]);
  });
  it("does not permit reconstructed state to substitute unrelated source evidence", () => {
    const p = plan(), r = receipt(p);
    expect(reviewProcessStartingState(p, {...r, entries: r.entries.map(entry => entry.facet === "history" ? {...entry, sourceEvidence: [ref("foreign-history")]} : entry)}))
      .toContain("starting_source_mismatch:history");
  });
  it("keeps a missing declared capture source visible", () => {
    const p = plan();
    const capture = assembleProcessCapture({plan: p, ref: ref("capture"), startedAt: p.trial.createdAt, completedAt: p.trial.createdAt, sources: []});
    expect(capture.status).not.toBe("complete"); expect(capture.sources[0].status).toBe("unavailable");
  });
  it("recovers an accepted stimulus after acknowledgement loss without duplicating recipient input", async () => {
    let saved: any = null, loseAcknowledgement = true;
    const accepted = new Map();
    const io = {load: async () => saved, commit: async (expected: any, next: any) => {
      expect(saved).toEqual(expected);
      if (next.recipientReceipt && loseAcknowledgement) {loseAcknowledgement = false; throw new Error("acknowledgement lost");}
      saved = structuredClone(next);
    }, verify: async (fact: any) => fact.evidence.id === "accepted-fact", accept: async (delivery: any) => {
      if (!accepted.has(delivery.id)) accepted.set(delivery.id, ref("recipient-input")); return accepted.get(delivery.id);
    }};
    const facts = [{owner: "run", fact: "effect_accepted", subject: "root", evidence: ref("accepted-fact")}];
    const p = plan();
    expect(await new EvaluationProcessStimulusDelivery(p, io).deliver([{...facts[0], evidence: ref("untrusted")}])).toEqual([]);
    await expect(new EvaluationProcessStimulusDelivery(p, io).deliver(facts)).rejects.toThrow(/acknowledgement/);
    const result = await new EvaluationProcessStimulusDelivery(p, io).deliver(facts);
    expect(result[0].recipientReceipt).toEqual(ref("recipient-input")); expect(accepted.size).toBe(1);
    await new EvaluationProcessStimulusDelivery(p, io).deliver(facts); expect(accepted.size).toBe(1);
  });
});
describe("owned process resources", () => {
  it("closes a late creation and never admits a new one after cancellation", async () => {
    const scope = new ProcessResourceScope(); let complete!: (value: any) => void;
    const close = vi.fn(async () => {});
    const pending = scope.acquire("late", "worker", () => new Promise(resolve => {complete = resolve;}));
    const caught = pending.catch(error => error.message);
    await Promise.resolve();
    const first = await scope.close(5); expect(first.status).toBe("quarantined");
    complete({id: "late", kind: "worker", close});
    expect(await caught).toBe("process_resource_admission_closed");
    expect(close).toHaveBeenCalledTimes(1);
    expect((await scope.close(5)).status).toBe("cleaned");
    await expect(scope.acquire("new", "worker", async () => ({id: "new", kind: "worker", close}))).rejects.toThrow(/admission_closed/);
  });
  it("retains uncertain failed creations rather than claiming successful cleanup", async () => {
    const scope = new ProcessResourceScope();
    await expect(scope.acquire("unknown", "process", async () => {throw new Error("spawn acknowledgement lost");})).rejects.toThrow();
    expect((await scope.close(10)).status).toBe("quarantined");
  });
});
describe("durable process trial orchestration", () => {
  it("resumes an interrupted original target, recaptures, and never reruns a completed target", async () => {
    const p = plan(), io = ports(p);
    const original = io.target.invoke;
    let count = 0;
    io.target.invoke = vi.fn(async (...args) => ({...await original(...args), status: ++count === 1 ? "interrupted" : "completed"}));
    const first = await new EvaluationProcessExecution(io).run(p, control());
    expect(first.report.execution).toBe("interrupted");
    const second = await new EvaluationProcessExecution(io).run(p, control());
    expect(second.report.execution).toBe("completed"); expect(io.environment.prepare).toHaveBeenCalledTimes(1);
    expect(io.environment.verify).toHaveBeenCalledTimes(1); expect(io.capture).toHaveBeenCalledTimes(2);
    await new EvaluationProcessExecution(io).run(p, control()); expect(io.target.invoke).toHaveBeenCalledTimes(2);
    await expect(new EvaluationProcessExecution(io).run({...p, targetInput: "changed"}, control())).rejects.toThrow(/binding_mismatch/);
  });
  it("rejects stale bindings before target execution", async () => {
    const p = plan(), io = ports(p);
    io.environment.prepare = async () => ({...receipt(p), branch: plan("other").branch});
    const result = await new EvaluationProcessExecution(io).run(p, control());
    expect(result.report.execution).toBe("failed"); expect(io.target.invoke).not.toHaveBeenCalled();
  });
  it("cancels, joins the target and allows a clean following Trial", async () => {
    const p = plan(), io = ports(p); let release!: () => void;
    io.target.invoke = async (_input, r, _scope, signal) => {
      await new Promise<void>(resolve => {release = resolve; signal.addEventListener("abort", resolve as () => void, {once: true});});
      return {status: "failed", bindings: r.bindings, executionRef: ref("execution"), evidence: [], reason: "cancelled"};
    };
    io.target.cancel = vi.fn(async () => {release?.();});
    const result = await new EvaluationProcessExecution(io).run(p, {...control(), timeoutMs: 10});
    expect(result.report.execution).toBe("timed_out"); expect(result.report.cleanup.status).toBe("cleaned");
    const next = plan("next"); expect((await new EvaluationProcessExecution(ports(next)).run(next, control())).report.execution).toBe("completed");
  });
  it("keeps capture failure and report-save failure separate from completed work", async () => {
    const p = plan(), io = ports(p); io.capture = async () => {throw new Error("capture unreadable");};
    io.saveReport = async () => {throw new Error("report disk full");};
    const result = await new EvaluationProcessExecution(io).run(p, control());
    expect(result.report.execution).toBe("completed"); expect(result.report.failures.some(f => f.stage === "capture")).toBe(true);
    expect(result.reportFailure).toContain("disk full"); expect(result.savedReport).toBeNull();
    io.saveReport = async () => ref("report");
    await new EvaluationProcessExecution(io).run(p, control()); expect(io.target.invoke).toHaveBeenCalledTimes(1);
  });
  it("quarantines an uncooperative capture and refuses to reuse that Trial", async () => {
    const p = plan(), io = ports(p);
    io.capture = async () => new Promise(() => {});
    const result = await new EvaluationProcessExecution(io).run(p, {...control(), captureTimeoutMs: 5, cleanupTimeoutMs: 5});
    expect(result.report.execution).toBe("completed"); expect(result.report.cleanup.status).toBe("quarantined");
    expect(result.report.failures.some(f => f.stage === "capture")).toBe(true);
    await expect(new EvaluationProcessExecution(io).run(p, control())).rejects.toThrow(/quarantined/);
  });
  it("bounds independent assessment and marks omitted claims as insufficient", async () => {
    const p = plan(), io = ports(p); io.assess = async () => [];
    const result = await new EvaluationProcessExecution(io).run(p, control());
    expect(result.report.conclusions).toEqual([expect.objectContaining({claim: "effect-once", verdict: "insufficient_evidence"})]);
    const next = ports(p); next.assess = async (_capture, _refs, _scope, signal) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), {once: true})); return [];
    };
    const timed = await new EvaluationProcessExecution(next).run(p, {...control(), captureTimeoutMs: 5});
    expect(timed.report.failures.some(f => f.stage === "assessment")).toBe(true); expect(timed.report.cleanup.status).toBe("cleaned");
  });
  it("reports uncertain report persistence separately without reexecuting work", async () => {
    const p = plan(), io = ports(p); io.saveReport = async () => new Promise(() => {});
    const result = await new EvaluationProcessExecution(io).run(p, {...control(), captureTimeoutMs: 5, cleanupTimeoutMs: 5});
    expect(result.report.execution).toBe("completed"); expect(result.reportFailure).toContain("report_timeout");
    expect(result.reportCleanup?.status).toBe("quarantined");
    await expect(new EvaluationProcessExecution(io).run(p, control())).rejects.toThrow(/quarantined/);
    expect(io.target.invoke).toHaveBeenCalledTimes(1);
  });
  it("retains target failures and rejects unsupported positive judgments", async () => {
    const p = plan(), io = ports(p);
    io.target.invoke = async () => ({status: "failed", bindings: receipt(p).bindings, executionRef: ref("execution"), evidence: [], reason: "original target failure"});
    io.assess = async () => [{claim: "effect-once", verdict: "conforms", evidence: [], explanation: "unsupported assertion"}];
    const result = await new EvaluationProcessExecution(io).run(p, control());
    expect(result.report.execution).toBe("failed");
    expect(result.report.failures).toContainEqual({stage: "execution", reason: "original target failure"});
    expect(result.report.failures).toContainEqual({stage: "assessment", reason: "process_invalid_or_duplicate_claim"});
    expect(result.report.conclusions).toEqual([expect.objectContaining({verdict: "insufficient_evidence"})]);
    expect(result.report.limitations).toContain("controlled_target_only");
  });
  it("does not capture an unquiesced target or assess absent evidence", async () => {
    const p = plan(), io = ports(p);
    io.target.invoke = async () => new Promise(() => {});
    const result = await new EvaluationProcessExecution(io).run(p, {...control(), timeoutMs: 5, cleanupTimeoutMs: 5});
    expect(result.report.cleanup.status).toBe("quarantined");
    expect(io.capture).not.toHaveBeenCalled(); expect(io.assess).not.toHaveBeenCalled();
    expect(result.report.conclusions[0].verdict).toBe("insufficient_evidence");
  });
});
