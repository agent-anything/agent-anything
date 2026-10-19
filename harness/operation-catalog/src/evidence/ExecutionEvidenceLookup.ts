import type { ExecutionEvidenceAccessPort, ExecutionEvidenceRecordPort } from "./ExecutionEvidencePort.js";
import { evidenceMemberRefs, executionEvidenceKey, snapshotExecutionEvidence, snapshotExecutionEvidenceRef,
  type ExecutionEvidenceRecord, type ExecutionEvidenceRef } from "./ExecutionEvidence.js";
import { snapshotCompensationAssociation, type CompensationAssociation } from "./CompensationAssociation.js";

export class ExecutionEvidenceUnavailableError extends Error {
  readonly code = "execution_reference_unavailable";
  constructor() { super("Use an exact execution or effect reference disclosed to this Run; current access is required."); }
}

export async function resolveExecutionEvidence(input: {
  readonly runId: string;
  readonly reference: ExecutionEvidenceRef;
  readonly records: ExecutionEvidenceRecordPort;
  readonly access: ExecutionEvidenceAccessPort;
}): Promise<ExecutionEvidenceRecord> {
  const reference = snapshotExecutionEvidenceRef(input.reference);
  const retained = await input.records.readExecutionEvidence(reference);
  if (!retained) throw new ExecutionEvidenceUnavailableError();
  const record = snapshotExecutionEvidence(retained);
  if (!evidenceMemberRefs(record).some(ref => executionEvidenceKey(ref) === executionEvidenceKey(reference)) ||
      !await input.access.canInspect({runId: input.runId, record, reference})) throw new ExecutionEvidenceUnavailableError();
  return record;
}

/** Resolve every target before admitting any new effect. Invalid targets are not dropped. */
export async function resolveCompensationAssociation(input: {
  readonly proposal: Omit<CompensationAssociation, "targets"> & {readonly targets: readonly ExecutionEvidenceRef<"execution" | "effect">[]};
  readonly runId: string;
  readonly records: ExecutionEvidenceRecordPort;
  readonly access: ExecutionEvidenceAccessPort;
}): Promise<CompensationAssociation> {
  if (!Array.isArray(input.proposal.targets) || input.proposal.targets.length < 1 || input.proposal.targets.length > 64 ||
      input.proposal.correlation.kind !== "run_action" || input.proposal.correlation.run.id !== input.runId) {
    throw new TypeError("Invalid compensation target set or requesting Run.");
  }
  const targets: CompensationAssociation["targets"][number][] = [];
  for (const requested of input.proposal.targets) {
    if (requested.kind !== "execution" && requested.kind !== "effect") throw new TypeError("Compensation requires execution or effect references.");
    const record = await resolveExecutionEvidence({...input, reference: requested});
    targets.push({requested, execution: record.ref, result: record.source.result, resultRevision: record.source.resultRevision, sourceCorrelation: record.source.correlation});
  }
  return snapshotCompensationAssociation({...input.proposal, targets});
}
