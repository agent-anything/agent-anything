import { snapshotEvaluationData, type EvaluationDataValue } from "../contract/EvaluationData.js";
import { createEvaluationRecordRef, type EvaluationRecordRef } from "../contract/EvaluationPrimitives.js";
import { createEvaluationTrial, type EvaluationTrial } from "../trial/EvaluationTrial.js";

export const processStartingStateFacets = [
  "history", "native_groups", "sources", "materials", "representations", "accepted_deliveries",
  "pending_deliveries", "ongoing_requirements", "retention_and_access", "completed_effects",
  "unfinished_work", "control", "descendant_recipients",
] as const;
export type ProcessStartingStateFacet = typeof processStartingStateFacets[number];
export interface ProcessStartingStateEntry {
  readonly facet: ProcessStartingStateFacet;
  readonly owner: string;
  readonly disposition: "empty" | "reconstructible" | "unavailable";
  readonly evidence: readonly EvaluationRecordRef[];
}
export interface EvaluationProcessStartingState {
  readonly ref: EvaluationRecordRef;
  readonly construction: EvaluationRecordRef;
  readonly boundary: "task_start" | "before_investment" | "before_method" | "before_adoption";
  readonly entries: readonly ProcessStartingStateEntry[];
}
export interface ProcessBranchIdentity {
  readonly trialId: string;
  readonly branchId: string;
  readonly workspaceId: string;
  readonly storageId: string;
  readonly authorityId: string;
  readonly activityNamespace: string;
  readonly commonHistory: EvaluationRecordRef | null;
}
export interface ProcessFutureStimulus {
  readonly id: string;
  readonly condition: { readonly owner: string; readonly fact: string; readonly subject: string };
  readonly input: EvaluationDataValue;
}
export interface EvaluationProcessPlan {
  readonly trial: EvaluationTrial;
  readonly mode: "evidence_audit" | "fixed_continuation" | "actual_process";
  readonly startingState: EvaluationProcessStartingState;
  readonly branch: ProcessBranchIdentity;
  readonly targetInput: EvaluationDataValue;
  readonly variants: readonly { readonly name: string; readonly value: EvaluationDataValue }[];
  readonly expectationRefs: readonly EvaluationRecordRef[];
  readonly claimRefs: readonly EvaluationRecordRef[];
  readonly captureSources: readonly string[];
  readonly captureBounds: {readonly maxBytesPerSource: number; readonly maxRecordsPerSource: number};
  readonly futureStimuli: readonly ProcessFutureStimulus[];
  readonly capturePolicyRef: EvaluationRecordRef;
  readonly evidenceLimitations: readonly string[];
}
export interface ProcessStartingStateReceipt {
  readonly startingStateRef: EvaluationRecordRef;
  readonly branch: ProcessBranchIdentity;
  readonly bindings: EvaluationRecordRef;
  readonly entries: readonly {
    readonly facet: ProcessStartingStateFacet;
    readonly owner: string;
    readonly disposition: "confirmed_empty" | "reconstructed" | "unsupported";
    readonly sourceEvidence: readonly EvaluationRecordRef[];
    readonly evidence: readonly EvaluationRecordRef[];
  }[];
}
export interface ProcessConditionFact {
  readonly owner: string;
  readonly fact: string;
  readonly subject: string;
  readonly evidence: EvaluationRecordRef;
}

export function createEvaluationProcessPlan(input: EvaluationProcessPlan): EvaluationProcessPlan {
  createEvaluationTrial(input.trial);
  const plan = snapshotEvaluationData(input) as unknown as EvaluationProcessPlan;
  if (!["evidence_audit", "fixed_continuation", "actual_process"].includes(plan.mode)) throw new TypeError("Unsupported process mode");
  if (!["task_start", "before_investment", "before_method", "before_adoption"].includes(plan.startingState.boundary)) throw new TypeError("Unsupported starting boundary");
  assertRef(plan.startingState.ref); assertRef(plan.startingState.construction); assertRef(plan.capturePolicyRef);
  for (const ref of plan.expectationRefs) assertRef(ref);
  for (const ref of plan.claimRefs) assertRef(ref);
  for (const source of plan.captureSources) nonempty(source);
  for (const limitation of plan.evidenceLimitations) nonempty(limitation);
  if (!plan.captureSources.length || new Set(plan.captureSources).size !== plan.captureSources.length) throw new TypeError("Capture requires unique declared sources");
  if (new Set(plan.claimRefs.map(ref => ref.id)).size !== plan.claimRefs.length) throw new TypeError("Claims must have unique identities");
  for (const bound of [plan.captureBounds.maxBytesPerSource, plan.captureBounds.maxRecordsPerSource]) if (!Number.isSafeInteger(bound) || bound <= 0) throw new TypeError("Capture bounds must be positive integers");
  if (plan.branch.trialId !== plan.trial.ref.id) throw new TypeError("Branch does not belong to Trial");
  for (const key of isolationKeys) nonempty(plan.branch[key]);
  if (plan.branch.commonHistory) assertRef(plan.branch.commonHistory);
  const facets = new Set<string>();
  for (const entry of plan.startingState.entries) {
    if (!processStartingStateFacets.includes(entry.facet) || facets.has(entry.facet)) throw new TypeError("Duplicate or unknown starting facet");
    facets.add(entry.facet); nonempty(entry.owner);
    if (!["empty", "reconstructible", "unavailable"].includes(entry.disposition)) throw new TypeError("Unknown starting disposition");
    if ((entry.disposition === "empty") !== (entry.evidence.length === 0) && entry.disposition !== "unavailable") throw new TypeError("Starting state requires explicit evidence or explicit emptiness");
    entry.evidence.forEach(assertRef);
  }
  if (facets.size !== processStartingStateFacets.length) throw new TypeError("Starting state must cover every responsibility");
  const ids = new Set<string>();
  for (const stimulus of plan.futureStimuli) {
    nonempty(stimulus.id); nonempty(stimulus.condition.owner); nonempty(stimulus.condition.fact); nonempty(stimulus.condition.subject);
    if (ids.has(stimulus.id)) throw new TypeError("Duplicate stimulus identity"); ids.add(stimulus.id);
  }
  const variants = new Set<string>();
  for (const variant of plan.variants) {
    nonempty(variant.name); if (variants.has(variant.name)) throw new TypeError("Duplicate variation"); variants.add(variant.name);
  }
  return plan;
}

const isolationKeys = ["trialId", "branchId", "workspaceId", "storageId", "authorityId", "activityNamespace"] as const;
export function assertProcessBranchIsolation(branches: readonly ProcessBranchIdentity[]): void {
  for (const key of isolationKeys) {
    const seen = new Set<string>();
    for (const branch of branches) {
      nonempty(branch[key]);
      if (seen.has(branch[key])) throw new TypeError(`Branches share ${key}`);
      seen.add(branch[key]);
    }
  }
}
export function reviewProcessStartingState(plan: EvaluationProcessPlan, receipt: ProcessStartingStateReceipt): readonly string[] {
  const reasons: string[] = [];
  if (!same(receipt.startingStateRef, plan.startingState.ref) || !same(receipt.branch, plan.branch)) reasons.push("starting_identity_mismatch");
  assertRef(receipt.bindings);
  if (receipt.entries.length !== plan.startingState.entries.length || new Set(receipt.entries.map(entry => entry.facet)).size !== receipt.entries.length) reasons.push("starting_coverage_mismatch");
  for (const expected of plan.startingState.entries) {
    const actual = receipt.entries.find(entry => entry.facet === expected.facet);
    if (expected.disposition === "unavailable" || !actual || actual.owner !== expected.owner || actual.disposition === "unsupported") {
      reasons.push(`starting_unavailable:${expected.facet}`); continue;
    }
    if (expected.disposition === "empty" ? actual.disposition !== "confirmed_empty" : actual.disposition !== "reconstructed" || actual.evidence.length === 0) reasons.push(`starting_unconfirmed:${expected.facet}`);
    if (!same(expected.evidence, actual.sourceEvidence)) reasons.push(`starting_source_mismatch:${expected.facet}`);
    actual.evidence.forEach(assertRef);
  }
  return Object.freeze(reasons);
}

// This is the only initial input projection exposed to an executing target.
export function projectProcessTargetInput(plan: EvaluationProcessPlan) {
  return snapshotEvaluationData({trialRef: plan.trial.ref, targetSnapshotRef: plan.trial.targetSnapshotRef,
    mode: plan.mode, startingState: plan.startingState, branch: plan.branch, input: plan.targetInput, variants: plan.variants});
}
export function selectProcessStimuli(plan: EvaluationProcessPlan, facts: readonly ProcessConditionFact[], delivered: readonly string[]) {
  return plan.futureStimuli.flatMap(stimulus => {
    if (delivered.includes(stimulus.id)) return [];
    const basis = facts.find(fact => fact.owner === stimulus.condition.owner && fact.fact === stimulus.condition.fact && fact.subject === stimulus.condition.subject);
    if (!basis) return [];
    assertRef(basis.evidence);
    return [{id: stimulus.id, input: stimulus.input, basis: basis.evidence}];
  });
}
function assertRef(ref: EvaluationRecordRef) { createEvaluationRecordRef(ref); }
function nonempty(value: string) { if (typeof value !== "string" || !value.trim()) throw new TypeError("An explicit identity is required"); }
export function sameProcessValue(left: unknown, right: unknown): boolean { return same(left, right); }
function same(left: unknown, right: unknown) { return JSON.stringify(snapshotEvaluationData(left)) === JSON.stringify(snapshotEvaluationData(right)); }
