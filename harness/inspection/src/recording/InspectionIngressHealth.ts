import { initialInspectionProgress, type InspectionAdmissionReason, type InspectionIngressHealth, type InspectionSubjectRef } from "../records/index.js";

/** One bounded cumulative control snapshot; never queued as a captured fact. */
export class InspectionIngressAccounting {
  private current: InspectionIngressHealth = initialInspectionProgress().ingress;
  snapshot(): InspectionIngressHealth { return structuredClone(this.current); }
  accepted(records: number, structureBytes: number, contentBytes: number, durationMs: number): void {
    const previous = this.current;
    this.current = {...previous, revision: previous.revision + 1, accepted: previous.accepted + 1,
      highWater: {records: Math.max(previous.highWater.records, records), structureBytes: Math.max(previous.highWater.structureBytes, structureBytes), contentBytes: Math.max(previous.highWater.contentBytes, contentBytes)},
      timings: {...previous.timings, admissionMaxMs: Math.max(previous.timings.admissionMaxMs, durationMs)}};
  }
  rejected(reason: InspectionAdmissionReason, sequence: number | null, subject: InspectionSubjectRef | null): void {
    const previous = this.current;
    const at = new Date().toISOString();
    const issue = previous.issues.find(value => value.reason === reason);
    const samples = [...(issue?.samples ?? [])];
    if (samples.length < 8) samples.push({sequence, subject});
    const next = {reason, count: (issue?.count ?? 0) + 1, firstSequence: issue?.firstSequence ?? sequence, lastSequence: sequence,
      firstAt: issue?.firstAt ?? at, lastAt: at, samples, coalesced: (issue?.count ?? 0) >= 8};
    const dropped = reason === "record_capacity" || reason === "structure_capacity" || reason === "content_capacity";
    this.current = {...previous, revision: previous.revision + 1, dropped: previous.dropped + Number(dropped), rejected: previous.rejected + Number(!dropped),
      issues: [...previous.issues.filter(value => value.reason !== reason), next]};
  }
  timing(kind: "queueMaxMs" | "acknowledgementMaxMs", durationMs: number): void {
    if (durationMs <= this.current.timings[kind]) return;
    this.current = {...this.current, revision: this.current.revision + 1, timings: {...this.current.timings, [kind]: durationMs}};
  }
}
