import type { ToolResultPresenter } from "@agent-anything/agent-runtime/runner";
import { snapshotExecutionEvidence, snapshotExecutionEvidenceRef, validateExecutionEffectSchemas, type ExecutionEvidenceRecord, type ExecutionEvidenceRecordPort } from "@agent-anything/operation-catalog/evidence";
import type { OperationResult } from "@agent-anything/operation-catalog/result";
import { CODE_FILE_CONTENT_CHANGE_SCHEMA, codeFileExecutionEffects, codeFileCompensationSupport } from "@agent-anything/helarc-code-agent/file-operation";
import {HELARC_PROCESS_EFFECT_SCHEMA, helarcProcessEvidence} from "./HelarcProcessEvidence.js";

type CommittedResult = Parameters<NonNullable<ToolResultPresenter["committed"]>>[0];

export function helarcExecutionReference(result: OperationResult) {
  return snapshotExecutionEvidenceRef({owner: result.semanticOwner, kind: "execution", id: result.ref.id, revision: "1"});
}

export function helarcExecutionReferences(result: OperationResult) {
  const process = helarcProcessEvidence(result);
  return Object.freeze([helarcExecutionReference(result), ...codeFileExecutionEffects(result).map(effect => effect.ref),
    ...codeFileCompensationSupport(result).flatMap(support => [support.ref, ...support.materials.map(material => material.ref)]),
    ...process.effects.map(effect => effect.ref), ...process.support.map(support => support.ref)]);
}

/** Records public-invocation facts, not an inventory of arbitrary external effects. */
export async function commitHelarcExecutionEvidence(records: ExecutionEvidenceRecordPort, input: CommittedResult): Promise<void> {
  const {result, correlation} = input;
  if (correlation.kind !== "run_action" || correlation.run.id !== input.runId ||
      correlation.runAction.id !== input.call.parentRunAction.id ||
      correlation.runAction.sequence !== input.call.parentRunAction.sequence ||
      input.call.parentRunAction.run.id !== input.runId) {
    throw new TypeError("Execution evidence must retain its committed Tool caller.");
  }
  const certainty = result.metadata.effectCertainty;
  const extent = result.metadata.completionExtent;
  const process = helarcProcessEvidence(result);
  const evidence: ExecutionEvidenceRecord = snapshotExecutionEvidence({
    ref: helarcExecutionReference(result),
    source: {result: result.ref, resultRevision: input.resultRevision, binding: result.binding,
      correlation, lowerRefs: result.lowerRefs},
    recordedAt: result.finishedAt,
    outcome: {status: result.status,
      effectCertainty: certainty === "none" || certainty === "confirmed" || certainty === "partial" ? certainty : "unknown",
      completionExtent: extent === "none" || extent === "partial" || extent === "complete" ? extent : "unknown"},
    coverage: {scope: "Public Operation outcome and its recorded lower execution references", extent: "partial",
      limitations: ["This record is not a complete inventory of external effects or compensation support.",
        "A successful Operation does not establish that arbitrary command or remote effects are known."]},
    effects: [...codeFileExecutionEffects(result), ...process.effects], support: [...codeFileCompensationSupport(result), ...process.support],
  });
  validateExecutionEffectSchemas(evidence, [CODE_FILE_CONTENT_CHANGE_SCHEMA, HELARC_PROCESS_EFFECT_SCHEMA]);
  await records.commitExecutionEvidence(evidence);
}
