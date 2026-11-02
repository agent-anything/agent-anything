import {assembleEvaluationCapture, createEvaluationCapturePolicy, type EvaluationCapture} from "../capture/EvaluationCapture.js";
import type {EvaluationRecordRef} from "../contract/EvaluationPrimitives.js";
import type {EvaluationProcessPlan} from "./ProcessDefinition.js";
import type {ProcessCaptureResult} from "./ProcessExecution.js";

export function assembleProcessCapture(input: {readonly plan: EvaluationProcessPlan; readonly ref: EvaluationRecordRef;
  readonly sources: ProcessCaptureResult["sources"]; readonly startedAt: string; readonly completedAt: string}): ProcessCaptureResult {
  const schemaRef = {schemaId: "evaluation-process-source-coverage", revision: "1"};
  if (new Set(input.sources.map(source => source.owner)).size !== input.sources.length ||
    input.sources.some(source => !input.plan.captureSources.includes(source.owner))) throw new Error("process_capture_source_mismatch");
  const sources: ProcessCaptureResult["sources"] = input.plan.captureSources.map(owner => input.sources.find(source => source.owner === owner) ??
    {owner, status: "unavailable", refs: [], reason: "Declared source was not captured"});
  const policy = createEvaluationCapturePolicy({ref: input.plan.capturePolicyRef, createdAt: input.startedAt, metadata: {}, limitations: [],
    slots: sources.map(source => ({id: source.owner, owner: source.owner, schemaRef, required: true, maximumSensitivity: "internal",
      contentMode: "inline", retention: "report", maximumBytes: 32768, optionalOmission: "complete", consumers: []}))});
  const {capture} = assembleEvaluationCapture({ref: input.ref, trialRef: input.plan.trial.ref,
    targetSnapshotRef: input.plan.trial.targetSnapshotRef, caseRef: input.plan.trial.caseRef, policy,
    environmentRef: {id: input.plan.branch.storageId, revision: "1"}, startedAt: input.startedAt, completedAt: input.completedAt,
    measurements: [], metadata: {}, limitations: [], contributions: sources.map(source => ({slotId: source.owner, owner: source.owner,
      schemaRef, sensitivity: "internal", status: source.status === "complete" ? "captured" : "unavailable",
      content: source.status === "complete" ? {kind: "inline", value: {evidenceRefs: source.refs.map(ref => ({...ref}))}} : null,
      reason: source.status === "complete" ? null : {code: "process_source_coverage_incomplete", message: source.reason ?? "Coverage incomplete",
        sourceOwner: source.owner, details: {coverage: source.status, availableReferences: source.refs.map(ref => ({...ref}))}},
    }))});
  return {ref: capture.ref, status: capture.status, sources, capture};
}

export function assertProcessCaptureBinding(plan: EvaluationProcessPlan, value: ProcessCaptureResult): void {
  const equal = (a: EvaluationRecordRef, b: EvaluationRecordRef) => a.id === b.id && a.revision === b.revision;
  const capture: EvaluationCapture = value.capture;
  if (!equal(capture.ref, value.ref) || !equal(capture.trialRef, plan.trial.ref) || !equal(capture.caseRef, plan.trial.caseRef) ||
    !equal(capture.targetSnapshotRef, plan.trial.targetSnapshotRef) || !equal(capture.policyRef, plan.capturePolicyRef) || capture.status !== value.status ||
    capture.slots.length !== plan.captureSources.length || plan.captureSources.some(owner => !capture.slots.some(slot => slot.owner === owner && slot.required)))
    throw new Error("process_capture_binding_mismatch");
}
