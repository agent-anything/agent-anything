import {snapshotProviderRequest, type ProviderRequest, type ProviderUsage} from "@agent-anything/model-interaction";
import {applyModelInputAccounts, applyModelInputOwnerForms, modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {assembleEvaluationCapture, createEvaluationCapturePolicy, type EvaluationCapture} from "@agent-anything/evaluation/capture";
import type {EvaluationDataValue, EvaluationRecordRef} from "@agent-anything/evaluation/definition";

export const CONTEXT_TRANSFORMATION_EVALUATION_REVISION = "context-transformation-evaluation.v1";
export const CONTEXT_TRANSFORMATION_CRITERIA = ["truthfulness", "coherence", "consistency", "non_redundancy", "functional_preservation",
  "relational_completeness", "continuation_sufficiency", "loss_transparency"] as const;
export interface ContextTransformationFinding {
  readonly criterion: typeof CONTEXT_TRANSFORMATION_CRITERIA[number];
  readonly verdict: "adequate" | "inadequate" | "unknown";
  readonly reason: string;
  readonly evidence: readonly EvaluationRecordRef[];
}
export interface ContextTransformationEvidence {
  readonly request: ProviderRequest;
  readonly capturedRequest: EvaluationRecordRef | null;
  readonly captureComplete: boolean;
  readonly attempts: readonly {readonly id: string; readonly purpose: string; readonly usage: ProviderUsage | null; readonly durationMs: number | null}[];
  readonly outcomes: EvaluationDataValue;
}
export interface ContextTransformationTrialPlan {
  readonly ref: EvaluationRecordRef;
  readonly caseRef: EvaluationRecordRef;
  readonly targetSnapshot: EvaluationRecordRef;
  readonly environment: EvaluationRecordRef;
  readonly mode: "evidence_audit" | "representation_comparison" | "continued_execution";
  readonly replicateKey: string;
  readonly armOrder: readonly ["retained" | "transformed", "retained" | "transformed"];
  readonly source: ContextTransformationEvidence;
  readonly candidate?: ContextTransformationEvidence;
  readonly oracle: {readonly ref: EvaluationRecordRef; readonly expectedFacts: EvaluationDataValue; readonly permissibleOutcomes: EvaluationDataValue};
  readonly heldOutFollowUps: readonly string[];
  readonly timeoutMs: number;
}
export interface ContextTransformationTrialEnvironment {
  /** Independent isolated source snapshot; never the user's live workspace/store. */
  prepare(source: ProviderRequest, signal: AbortSignal): Promise<ContextTransformationEvidence>;
  continue(request: ProviderRequest, followUps: readonly string[], signal: AbortSignal): Promise<ContextTransformationEvidence>;
  /** Must settle all launched work before confirming cleanup. */
  close(): Promise<boolean>;
}
export interface ContextTransformationTrialReport {
  readonly planDigest: string;
  readonly mode: ContextTransformationTrialPlan["mode"];
  readonly captures: readonly EvaluationCapture[];
  readonly findings: readonly ContextTransformationFinding[];
  readonly structural: readonly {readonly check: string; readonly passed: boolean | null}[];
  readonly costs: readonly {readonly arm: string; readonly attempts: number; readonly inputTokens: number; readonly outputTokens: number;
    readonly unknownUsageAttempts: number; readonly requestDurationMs: number; readonly unknownDurationAttempts: number}[];
  readonly exclusions: readonly string[];
  readonly limitations: readonly string[];
}

/** Engineering target above the public composition. Semantic judgments are supplied
 * independently; production assessor approval is deliberately not an input grade. */
export async function runContextTransformationTrial(plan: ContextTransformationTrialPlan, ports: {
  open?(arm: "retained" | "transformed", target: EvaluationRecordRef, environment: EvaluationRecordRef, signal: AbortSignal): Promise<ContextTransformationTrialEnvironment>;
  judge?(evidence: {source: ContextTransformationEvidence; candidate: ContextTransformationEvidence;
    continuations: Readonly<Record<string, ContextTransformationEvidence>>; oracle: ContextTransformationTrialPlan["oracle"]}, signal: AbortSignal): Promise<readonly ContextTransformationFinding[]>;
} = {}): Promise<ContextTransformationTrialReport> {
  const fixed = structuredClone(plan), startedAt = new Date().toISOString(), planDigest = modelInputValueDigest(fixed);
  if (!fixed.ref.id || !fixed.replicateKey || !Number.isSafeInteger(fixed.timeoutMs) || fixed.timeoutMs < 1 || fixed.timeoutMs > 300000 ||
      fixed.armOrder.length !== 2 || new Set(fixed.armOrder).size !== 2 || fixed.armOrder.some(arm => !["retained", "transformed"].includes(arm))) throw new TypeError("Invalid fixed transformation Trial plan.");
  const source = snapshotEvidence(fixed.source), exclusions: string[] = [], environments: ContextTransformationTrialEnvironment[] = [];
  let candidate = fixed.candidate ? snapshotEvidence(fixed.candidate) : null;
  const continuations: Record<string, ContextTransformationEvidence> = {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("context_trial_timeout")), fixed.timeoutMs);
  const bounded = <T>(work: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    controller.signal.throwIfAborted();
    const abort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", abort, {once: true});
    Promise.resolve().then(work).then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
  });
  const structural: {check: string; passed: boolean | null}[] = [];
  let opening = 0;
  let findings: readonly ContextTransformationFinding[] = [];
  try {
    if (fixed.mode !== "evidence_audit") {
      if (!ports.open) throw new Error("isolated_environment_unavailable");
      for (const arm of fixed.armOrder) {
        // An environment returned after timeout is still owned and closed, never used.
        const environment = await bounded(async () => {
          opening++;
          let value: ContextTransformationTrialEnvironment;
          try {value = await ports.open!(arm, structuredClone(fixed.targetSnapshot), structuredClone(fixed.environment), controller.signal);}
          finally {opening--;}
          if (controller.signal.aborted) {void value.close().catch(() => {}); throw controller.signal.reason;}
          if (environments.includes(value)) throw new Error("isolated_environment_reused");
          environments.push(value); return value;
        });
        const request = arm === "transformed" ? (candidate = snapshotEvidence(await bounded(() => environment.prepare(snapshotProviderRequest(source.request), controller.signal)))).request : source.request;
        if (fixed.mode === "continued_execution") continuations[arm] = snapshotEvidence(await bounded(() => environment.continue(snapshotProviderRequest(request), [...fixed.heldOutFollowUps], controller.signal)));
      }
    }
    if (!candidate) throw new Error("candidate_evidence_unavailable");
    const before = source.request, after = candidate.request, runId = before.composition.workingView.recipientRunId;
    structural.push({check: "same_recipient", passed: runId !== null && runId === after.composition.workingView.recipientRunId},
      {check: "unchanged_instructions_and_capabilities", passed: modelInputValueDigest([before.instructions,before.interaction]) === modelInputValueDigest([after.instructions,after.interaction])});
    let reconstructed = false;
    try {
      const prior = before.composition.workingView, next = after.composition.workingView;
      const delta = <T>(previous: readonly T[], current: readonly T[]) => {
        if (modelInputValueDigest(previous) !== modelInputValueDigest(current.slice(0, previous.length))) throw new Error("Changed retained derivation");
        return current.slice(previous.length);
      };
      const forms = applyModelInputOwnerForms(before.composition.sections, delta(prior.forms ?? [], next.forms ?? []), runId!);
      const selected = applyModelInputAccounts(forms, delta(prior.accounts ?? [], next.accounts ?? []), runId!);
      reconstructed = modelInputValueDigest(selected) === modelInputValueDigest(after.composition.sections);
    } catch { /* Illegal transformation is a finding, not an unavailable source. */ }
    structural.push({check: "source_bound_representation", passed: reconstructed},
      {check: "captured_request_evidence", passed: source.captureComplete && candidate.captureComplete && source.capturedRequest !== null && candidate.capturedRequest !== null ? true : null});
    if (!source.captureComplete || !candidate.captureComplete) exclusions.push("capture_incomplete");
    if (!source.capturedRequest || !candidate.capturedRequest) exclusions.push("captured_request_reference_missing");
    if (ports.judge) {
      const proposed = structuredClone(await bounded(() => ports.judge!(structuredClone({source, candidate: candidate!, continuations, oracle: fixed.oracle}), controller.signal)));
      if (proposed.length !== CONTEXT_TRANSFORMATION_CRITERIA.length || new Set(proposed.map(value => value.criterion)).size !== proposed.length ||
          proposed.some(value => !CONTEXT_TRANSFORMATION_CRITERIA.includes(value.criterion) || !["adequate","inadequate","unknown"].includes(value.verdict) || !value.reason ||
            value.verdict !== "unknown" && !value.evidence.length)) throw new Error("independent_findings_invalid");
      findings = proposed;
    } else exclusions.push("independent_semantic_assessment_unavailable");
  } catch (error) {exclusions.push(error instanceof Error ? error.message : "trial_failed");}
  finally {
    clearTimeout(timer); controller.abort(new Error("trial_closed"));
    if (opening) exclusions.push("environment_open_cleanup_unconfirmed");
    for (const environment of environments.reverse()) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const closed = await Promise.race([environment.close(), new Promise<false>(resolve => {timeout = setTimeout(() => resolve(false), fixed.timeoutMs);})]);
        if (!closed) exclusions.push("environment_cleanup_unconfirmed");
      } catch {exclusions.push("environment_cleanup_failed");} finally {if (timeout) clearTimeout(timeout);}
    }
  }
  const evidence = [{arm:"retained", value:source}, ...(candidate ? [{arm:"transformed",value:candidate}] : []),
    ...Object.entries(continuations).map(([arm,value]) => ({arm:`${arm}:continuation`,value}))];
  const costs: ReturnType<typeof summarizeCost>[] = [];
  for (const {arm,value} of evidence) {
    try {costs.push(summarizeCost(arm,value));} catch {exclusions.push(`${arm}:attempt_accounting_invalid`);}
    if (!value.captureComplete || !value.capturedRequest) exclusions.push(`${arm}:request_evidence_incomplete`);
  }
  const captured = assembleEvaluationCapture({ref:{id:`${fixed.ref.id}:capture`,revision:CONTEXT_TRANSFORMATION_EVALUATION_REVISION},
    trialRef:fixed.ref, targetSnapshotRef:fixed.targetSnapshot, caseRef:fixed.caseRef, environmentRef:fixed.environment,
    policy:createEvaluationCapturePolicy({ref:{id:"context-transformation-capture",revision:CONTEXT_TRANSFORMATION_EVALUATION_REVISION},
      slots:[{id:"trial-evidence",required:true,owner:"context-continuity-evaluation",schemaRef:{schemaId:"context-transformation-evidence",revision:"1"},
        maximumSensitivity:"internal",contentMode:"inline",retention:"report",maximumBytes:512*1024,optionalOmission:"complete",consumers:[]}],
      createdAt:startedAt,metadata:{},limitations:[]}),
    contributions:[{slotId:"trial-evidence",owner:"context-continuity-evaluation",schemaRef:{schemaId:"context-transformation-evidence",revision:"1"},
      sensitivity:"internal",status:"captured",content:{kind:"inline",value:JSON.parse(JSON.stringify({planDigest,oracle:fixed.oracle,structural,findings,costs,
        requests:evidence.map(({arm,value})=>({arm,requestId:value.request.requestId,capture:value.capturedRequest,complete:value.captureComplete,outcomes:value.outcomes})),exclusions}))},reason:null}],
    measurements:[],startedAt,completedAt:new Date().toISOString(),metadata:{mode:fixed.mode,replicateKey:fixed.replicateKey},limitations:[]});
  if (captured.status !== "captured") exclusions.push("evaluation_capture_incomplete");
  return {planDigest,mode:fixed.mode,captures:[captured.capture],findings,structural,costs,exclusions:[...new Set(exclusions)],
    limitations:["structural_checks_do_not_establish_semantic_preservation","duration_is_summed_request_work_not_wall_time",
      "cache_tokens_are_not_added_to_input_tokens","capture_references_require_authorized_retention","single_trial_is_not_a_population_quality_claim"]};
}

function snapshotEvidence(value: ContextTransformationEvidence): ContextTransformationEvidence {
  return {...structuredClone(value), request:snapshotProviderRequest(value.request)};
}
function summarizeCost(arm: string, evidence: ContextTransformationEvidence) {
  const unique = new Map<string, ContextTransformationEvidence["attempts"][number]>();
  for (const attempt of evidence.attempts) {
    if (!attempt.id || !attempt.purpose || [attempt.usage?.inputTokens, attempt.usage?.outputTokens, attempt.durationMs]
        .some(value => value != null && (!Number.isFinite(value) || value < 0))) throw new TypeError("Invalid physical attempt evidence.");
    const previous=unique.get(attempt.id);
    if (previous && modelInputValueDigest(previous)!==modelInputValueDigest(attempt)) throw new TypeError("Conflicting physical attempt evidence.");
    unique.set(attempt.id,attempt);
  }
  const attempts=[...unique.values()];
  return {arm,attempts:attempts.length,inputTokens:attempts.reduce((sum,value)=>sum+(value.usage?.inputTokens ?? 0),0),
    outputTokens:attempts.reduce((sum,value)=>sum+(value.usage?.outputTokens ?? 0),0),
    unknownUsageAttempts:attempts.filter(value=>value.usage?.inputTokens==null || value.usage.outputTokens==null).length,
    requestDurationMs:attempts.reduce((sum,value)=>sum+(value.durationMs ?? 0),0),unknownDurationAttempts:attempts.filter(value=>value.durationMs===null).length};
}
