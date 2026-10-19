import type { ExecutionEvidenceObserver, ExecutionEvidenceObservation, ExecutionEvidenceRef } from "@agent-anything/operation-catalog/evidence";
import type { OperationCorrelation } from "@agent-anything/operation-catalog/identity";
import type { InspectionRecorder } from "../recording/index.js";
import type { InspectionJson } from "../records/index.js";
import { inspectionLink } from "./ProviderInspectionAdapter.js";

/** Observes acknowledged facts; never reads protected support bytes or authorizes actions. */
export class ExecutionEvidenceInspectionAdapter implements ExecutionEvidenceObserver {
  constructor(private readonly recorder: InspectionRecorder) {}
  observe(value: ExecutionEvidenceObservation): void {
    const r = this.recorder;
    const ref = (value: ExecutionEvidenceRef, runId: string | null) =>
      r.ref(value.owner, "contribution", `${value.kind}:${value.id}`, runId, value.revision);
    if (value.kind === "references_transferred") {
      const transfer = value.transfer;
      const subject = r.ref("operations", "contribution", transfer.id, transfer.recipientRunId, "1");
      const basisRunId = transfer.basis.kind === "delegation_result" ? transfer.recipientRunId : transfer.sourceRunId;
      r.offer({subject, occurredAt: transfer.acceptedAt,
        payload: {kind: "event", name: "execution.references.transferred", sequence: null, code: null},
        links: [inspectionLink("produces", r.ref(transfer.basis.owner, "contribution", transfer.basis.id, basisRunId, transfer.basis.revision), subject),
          inspectionLink("delivers", subject, r.ref("runtime", "run", transfer.recipientRunId, transfer.recipientRunId)),
          inspectionLink("includes", r.ref("runtime", "run", transfer.sourceRunId, transfer.sourceRunId), subject),
          ...(transfer.scope.kind === "references" ? transfer.scope.references.map(source => inspectionLink("includes", ref(source, transfer.sourceRunId), subject)) : [])],
        contents: [{name: "Accepted execution-reference handoff", class: "execution", stage: "committed", mediaType: "application/json", value: transfer as unknown as InspectionJson}]});
      return;
    }
    if (value.kind === "evidence_committed") {
      const record = value.record;
      const runId = correlatedRun(record.source.correlation);
      const execution = ref(record.ref, runId);
      const offer = (subject: ReturnType<typeof ref>, name: string, data: unknown, links: readonly ReturnType<typeof inspectionLink>[]) => r.offer({
        subject, occurredAt: record.recordedAt, payload: {kind: "event", name, sequence: null, code: null}, links,
        contents: [{name, class: "execution", stage: "committed", mediaType: "application/json", value: data as InspectionJson}]});
      offer(execution, "execution.evidence.committed", record, [
        inspectionLink("produces", r.ref("operations", "operation", record.source.result.invocation.id, runId), execution),
        inspectionLink("includes", r.ref("operations", "contribution", record.source.result.id, runId), execution),
      ]);
      for (const effect of record.effects) offer(ref(effect.ref, runId), "execution.effect.recorded", effect,
        [inspectionLink("contains", execution, ref(effect.ref, runId))]);
      for (const support of record.support) {
        const supportRef = ref(support.ref, runId);
        offer(supportRef, "execution.support.recorded", support, [inspectionLink("contains", execution, supportRef),
          ...support.effects.map(effect => inspectionLink("includes", ref(effect, runId), supportRef))]);
        for (const material of support.materials) offer(ref(material.ref, runId), "execution.material.described", material,
          [inspectionLink("contains", supportRef, ref(material.ref, runId))]);
      }
      return;
    }
    const association = value.association;
    const runId = correlatedRun(association.correlation);
    const intent = r.ref("operations", "contribution", association.id, runId, "1");
    r.offer({subject: intent, occurredAt: association.acceptedAt,
      payload: {kind: "event", name: "execution.compensation.intent_accepted", sequence: null, code: null},
      links: [inspectionLink("produces", r.ref("runtime", "call", association.call.id, runId), intent),
        inspectionLink("binding", intent, r.ref("operations", "operation", association.invocation.id, runId)),
        ...association.targets.map(target => inspectionLink("includes", ref(target.requested, correlatedRun(target.sourceCorrelation)), intent,
          {operation: "model_declared_compensation_target"}))],
      contents: [{name: "Declared compensation intent", class: "execution", stage: "accepted", mediaType: "application/json", value: association as unknown as InspectionJson}]});
  }
}

function correlatedRun(correlation: OperationCorrelation): string | null {
  return correlation.kind === "run_action" || correlation.kind === "run_request" ? correlation.run.id : null;
}
