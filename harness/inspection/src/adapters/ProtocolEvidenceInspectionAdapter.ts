import { nativeModelSourceKey, snapshotNativeModelSource, snapshotModelPurposeEvidence,
  type NativeModelSourceRef, type ModelPurposeEvidence } from "@agent-anything/model-interaction/protocol";
import type { InspectionRecorder } from "../recording/index.js";
import { snapshotInspectionJson } from "../records/InspectionValidation.js";
import { inspectionLink } from "./ProviderInspectionAdapter.js";

/** Records explicit relationships only; native payload custody and interpretation stay with their owners. */
export class ProtocolEvidenceInspectionAdapter {
  constructor(private readonly recorder: Pick<InspectionRecorder, "ref" | "offer">) {}

  source(input: NativeModelSourceRef): void {
    const source = snapshotNativeModelSource(input);
    const subject = this.recorder.ref(source.protocol.id, "event", nativeModelSourceKey(source), source.scope.runId, source.record.revision);
    const record = this.recorder.ref(source.protocol.id, "event", source.record.id, source.scope.runId, source.record.revision);
    const activity = this.recorder.ref("runtime", "event", source.scope.activityId, source.scope.runId);
    this.recorder.offer({ id: `native-source:${nativeModelSourceKey(source)}`, subject, occurredAt: null,
      payload: { kind: "event", name: "model.native_source_bound", sequence: null, code: null },
      links: [inspectionLink("binding", record, subject), inspectionLink("produces", activity, subject)],
      contents: [{ name: "Native source binding (not the native body)", stage: "source_binding", class: "provider", mediaType: "application/json", value: snapshotInspectionJson(source) }] });
  }

  accepted(input: ModelPurposeEvidence): void {
    const evidence = snapshotModelPurposeEvidence(input);
    const subject = this.recorder.ref("runtime", "event", evidence.acceptance.id, evidence.scope.runId, evidence.acceptance.revision);
    this.recorder.offer({ id: `purpose-acceptance:${evidence.scope.runId}:${evidence.acceptance.id}:${evidence.acceptance.revision}`, subject, occurredAt: null,
      payload: { kind: "event", name: "model.purpose_evidence_accepted", sequence: null, code: null },
      links: evidence.sources.map(source => inspectionLink("binding",
        this.recorder.ref(source.protocol.id, "event", nativeModelSourceKey(source), source.scope.runId, source.record.revision), subject)),
      contents: [{ name: "Purpose acceptance evidence", stage: "purpose_acceptance", class: "execution", mediaType: "application/json", value: snapshotInspectionJson(evidence) }] });
  }
}
