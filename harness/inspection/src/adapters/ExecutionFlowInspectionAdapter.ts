import type { ExecutionFlowObservation, ExecutionFlowObserver, ExecutionFlowOccurrenceRef } from "@agent-anything/observability/execution-flow";
import type { InspectionRecorder } from "../recording/index.js";
import type { InspectionJson, InspectionPayload, InspectionSubjectRef } from "../records/index.js";
import { inspectionFlowReference } from "../records/InspectionFlowReference.js";
import { inspectionLink } from "./ProviderInspectionAdapter.js";

export class ExecutionFlowInspectionAdapter implements ExecutionFlowObserver {
  private readonly definitions = new Set<string>();
  constructor(private readonly recorder: InspectionRecorder) {}
  observe(value: ExecutionFlowObservation): void {
    const r = this.recorder;
    const definition = r.ref(value.definition.owner, "flow-definition", value.definition.id, null, value.definition.revision);
    if (value.kind === "definition") {
      const key = `${value.definition.owner}:${value.definition.id}:${value.definition.revision}:${value.definition.contentDigest}`;
      if (this.definitions.has(key)) return;
      if (r.offer({id: `flow-definition:${value.definition.owner}:${value.definition.id}:${value.definition.revision}`, subject: definition, occurredAt: null, payload: {kind: "flow_definition", definition: value.definition}})) {
        if (this.definitions.size >= 1024) this.definitions.delete(this.definitions.values().next().value!);
        this.definitions.add(key);
      }
      return;
    }
    const occurrence = (ref: ExecutionFlowOccurrenceRef): InspectionSubjectRef => r.ref(ref.owner, ref.stepExecutionId === null ? "flow-invocation" : "flow-step", ref.stepExecutionId ?? ref.invocationId, ref.runId);
    const invocation = r.ref(value.definition.owner, "flow-invocation", value.invocationId, value.runId);
    if (value.kind === "material") {
      const subject = inspectionFlowReference(value.subject, invocation);
      r.offer({id: `flow:${value.invocationId}:${value.sequence}`, subject, occurredAt: value.occurredAt, ownerSequence: value.sequence,
        payload: {kind: "event", name: value.name, sequence: value.sequence, code: null},
        links: [inspectionLink("produces", invocation, subject, {operation: "capture_flow_material"})],
        contents: [{name: value.name, stage: value.stage, class: value.contentClass, mediaType: "application/json", value: value.value as InspectionJson}],
      });
      return;
    }
    const subject = "stepExecutionId" in value ? r.ref(value.definition.owner, "flow-step", value.stepExecutionId, value.runId) : invocation;
    let payload: InspectionPayload;
    switch (value.kind) {
      case "invocation_entered": case "invocation_exited": payload = {kind: "flow_invocation", observation: value}; break;
      case "step_entered": case "step_exited": payload = {kind: "flow_step", observation: value}; break;
      case "constraint": payload = {kind: "flow_constraint", observation: value}; break;
      case "link": payload = {kind: "flow_link", observation: value}; break;
    }
    const links = value.kind === "link" ? [inspectionLink(value.relation, occurrence(value.from), occurrence(value.to), {operation: value.transitionId})]
      : value.kind === "invocation_entered" ? [inspectionLink("contains", r.ref("runtime", "run", value.runId, value.runId), invocation), inspectionLink("binding", definition, invocation)]
      : value.kind === "step_entered" ? [inspectionLink("contains", invocation, subject)] : [];
    const refs = value.kind === "step_entered" ? value.inputs : value.kind === "step_exited" ? value.outputs
      : value.kind === "constraint" ? value.configuration ? [value.configuration] : []
      : value.kind === "link" ? value.establishedBy ? [value.establishedBy] : []
      : "subjects" in value ? value.subjects : [];
    for (const ref of refs) {
      let target: InspectionSubjectRef;
      try { target = inspectionFlowReference(ref, subject); } catch {
        r.offer({subject, occurredAt: value.occurredAt,
          payload: {kind: "event", name: "flow.reference_unmapped", sequence: value.sequence, code: "inspection_flow_reference_unmapped"},
          contents: [{name: "Unmapped flow reference", class: "agent", stage: "diagnostic", mediaType: "application/json", value: {...ref}}],
        });
        continue;
      }
      const input = value.kind === "step_entered" || value.kind === "constraint";
      const location = ref.contentId ? {contentId: ref.contentId, partId: null, jsonPointer: null, stage: "recorded"} : null;
      links.push(input ? inspectionLink("includes", target, subject, {sourceLocation: location})
        : inspectionLink("binding", subject, target, {targetLocation: location}));
    }
    r.offer({id: `flow:${value.invocationId}:${value.sequence}`, subject, occurredAt: value.occurredAt, ownerSequence: value.sequence, payload, links});
  }
}
