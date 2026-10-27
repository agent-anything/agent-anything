import {InspectionRecorder} from "@agent-anything/inspection/recording";
import {inspectionLink} from "@agent-anything/inspection/adapters";
import type {ContextMaterialObservation, ContextMaterialObserver} from "../execution-storage/ContextMaterialObservation.js";

/** Only committed owner facts; a read is not yet evidence of model consumption. */
export class ContextMaterialInspectionAdapter implements ContextMaterialObserver {
  constructor(private readonly recorder: InspectionRecorder) {}
  observe(value: ContextMaterialObservation): void {
    const r = this.recorder, runId = value.kind === "retention" ? value.transfer.recipientRunId : value.runId;
    const material = (ref: {id: string; revision: string}) => r.ref("context", "contribution", ref.id, null, ref.revision);
    if (value.kind === "published") {
      const subject = material(value.description.reference), source = value.description.source;
      r.offer({subject, occurredAt: new Date().toISOString(), payload: {kind: "event", name: "context.material.published", sequence: null, code: null},
        links: [inspectionLink("produces", source.kind === "run_item" ? r.ref("runtime", "event", source.id, value.description.originRunId)
          : r.ref(source.owner, source.kind === "command_output" ? "process" : "contribution", source.id, value.description.originRunId, source.kind === "command_output" ? null : source.revision), subject),
          inspectionLink("includes", r.ref("runtime", "run", runId, runId), subject)],
        contents: [{name: "Retained material description", class: "agent", stage: "retained", mediaType: "application/json", value: JSON.parse(JSON.stringify(value.description))}]});
      return;
    }
    const pending = value.kind === "access" && value.mode === "search" && value.coverage.state !== "returned";
    const identity = value.kind === "retention" ? `${value.transfer.id}:${value.state}` :
      `${value.invocationId}:material-${value.mode}:${pending ? value.coverage.state : value.reused ? "reused" : "saved"}`;
    const subject = r.ref("context", "contribution", identity, runId);
    const references = value.kind === "retention" ? value.transfer.references : value.references;
    r.offer({subject, occurredAt: new Date().toISOString(), payload: {kind: "event", name: `context.material.${value.kind === "retention" ? value.state : value.mode}`, sequence: null, code: null},
      links: [inspectionLink("includes", r.ref("runtime", "run", runId, runId), subject),
        ...references.map(ref => inspectionLink(value.kind === "access" && !pending ? "delivers" : "includes", material(ref), subject)),
        ...(value.kind === "access" ? [inspectionLink("produces", r.ref("operations", "operation", value.invocationId, runId), subject),
          ...(!pending ? [inspectionLink("produces", subject, r.ref("operations", "contribution", `${value.invocationId}:context-result`, runId))] : [])] : [])],
      contents: [{name: value.kind === "retention" ? "Material retention and transfer" : "Material access coverage", class: "agent", stage: "committed", mediaType: "application/json", value: JSON.parse(JSON.stringify(value))}]});
  }
}
