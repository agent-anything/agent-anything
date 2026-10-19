import type { InspectionRecorder } from "@agent-anything/inspection/recording";
import { inspectionLink } from "@agent-anything/inspection/adapters";
import type { FileMaterialObservation, FileMaterialObserver } from "@agent-anything/helarc-local-environment/filesystem";

/** Captures acknowledged owner metadata only. Historical file bytes require separate access/capture. */
export class FileMaterialInspectionAdapter implements FileMaterialObserver {
  constructor(private readonly recorder: InspectionRecorder) {}
  observe(value: FileMaterialObservation): void {
    const {record, kind, occurredAt} = value;
    const {preparation} = record;
    const r = this.recorder;
    const material = r.ref(preparation.ref.owner, "contribution", `material:${preparation.ref.id}`, preparation.runId, preparation.ref.revision);
    r.offer({subject: material, occurredAt,
      payload: {kind: "event", name: `file.material.${kind}.acknowledged`, sequence: null, code: record.reason},
      links: [inspectionLink("produces", r.ref("operations", "operation", preparation.invocation.id, preparation.runId), material),
        inspectionLink("includes", r.ref("action-execution", "attempt", `${preparation.attempt.action.id}:${preparation.attempt.id}`, preparation.runId), material)],
      contents: [{name: "File material retention", class: "execution", stage: kind, mediaType: "application/json", value: {
        reference: {...preparation.ref}, state: record.state, byteLength: preparation.byteLength, digest: record.digest,
        priorExistence: preparation.before.kind, policyRevision: preparation.policyRevision,
        preparedAt: preparation.preparedAt, publishedOrAbortedAt: record.finishedAt, expiresAt: record.expiresAt,
        pinCount: record.pins.length, reason: record.reason, readAuthorityRef: preparation.readAuthorityRef,
      }}]});
  }
}
