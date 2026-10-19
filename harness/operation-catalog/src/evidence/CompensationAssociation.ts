import { snapshotOperationCorrelation, snapshotOperationInvocationRef, type OperationCorrelation, type OperationInvocationRef } from "../identity/index.js";
import type { OperationResultRef } from "../result/OperationResult.js";
import { dateTime, denseArray, strictRecord, token } from "../contract/OperationContractValidation.js";
import { executionEvidenceKey, snapshotExecutionEvidenceRef, type ExecutionEvidenceRef } from "./ExecutionEvidence.js";

export interface CompensationAssociation {
  readonly id: string;
  readonly invocation: OperationInvocationRef;
  readonly correlation: OperationCorrelation;
  readonly call: {readonly id: string; readonly turnId: string};
  readonly targets: readonly {
    readonly requested: ExecutionEvidenceRef<"execution" | "effect">;
    readonly execution: ExecutionEvidenceRef<"execution">;
    readonly result: OperationResultRef;
    readonly resultRevision: string;
    readonly sourceCorrelation: OperationCorrelation;
  }[];
  readonly explanation: string | null;
  readonly acceptedAt: string;
}

/** Describes model intent and resolved sources, not a compensation outcome. */
export function snapshotCompensationAssociation(input: CompensationAssociation): CompensationAssociation {
  strictRecord(input, "compensation", ["id", "invocation", "correlation", "call", "targets", "explanation", "acceptedAt"]);
  strictRecord(input.call, "compensation.call", ["id", "turnId"]);
  const correlation = snapshotOperationCorrelation(input.correlation);
  if (correlation.kind !== "run_action" || correlation.provenance.kind !== "controller" ||
      correlation.provenance.turn.id !== input.call.turnId || correlation.provenance.turn.run.id !== correlation.run.id) invalid("model Call provenance");
  denseArray(input.targets, "compensation.targets");
  if (!input.targets.length || input.targets.length > 64) invalid("target count");
  const seen = new Set<string>();
  const targets = input.targets.map(target => {
    strictRecord(target, "compensation.target", ["requested", "execution", "result", "resultRevision", "sourceCorrelation"]);
    const requested = snapshotExecutionEvidenceRef(target.requested);
    const execution = snapshotExecutionEvidenceRef(target.execution, "execution");
    if (!["execution", "effect"].includes(requested.kind) || requested.owner !== execution.owner ||
        (requested.kind === "execution" && executionEvidenceKey(requested) !== executionEvidenceKey(execution))) invalid("target reference");
    const key = executionEvidenceKey(requested);
    if (seen.has(key)) invalid("duplicate target");
    seen.add(key);
    strictRecord(target.result, "compensation.result", ["id", "invocation"]);
    return Object.freeze({requested, execution, result: Object.freeze({id: token(target.result.id, "result.id", 1024),
      invocation: snapshotOperationInvocationRef(target.result.invocation)}), resultRevision: token(target.resultRevision, "resultRevision"),
      sourceCorrelation: snapshotOperationCorrelation(target.sourceCorrelation)});
  });
  if (input.explanation !== null && (typeof input.explanation !== "string" || input.explanation.length > 4096)) invalid("explanation");
  return Object.freeze({id: token(input.id, "compensation.id", 1024), invocation: snapshotOperationInvocationRef(input.invocation), correlation,
    call: Object.freeze({id: token(input.call.id, "call.id", 1024), turnId: token(input.call.turnId, "call.turnId", 1024)}),
    targets: Object.freeze(targets), explanation: input.explanation, acceptedAt: dateTime(input.acceptedAt, "acceptedAt")});
}
function invalid(part: string): never { throw new TypeError(`Compensation association has invalid ${part}.`); }
