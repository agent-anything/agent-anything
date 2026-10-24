import type { InspectionPayload } from "@agent-anything/inspection/records";

export function payloadSummary(payload: InspectionPayload): string {
  switch (payload.kind) {
    case "recording_link": return `Recovery recording / ${payload.target ? "previous recording registered" : payload.limitation ?? "unavailable"}`;
    case "context_planning": return `Context ${payload.disposition} / ${payload.measurement} / ${payload.inputTokens === null ? "input tokens unknown" : `${payload.inputTokens} input tokens`}`;
    case "working_view": return `Working input / ${payload.selectionCount} selections / ${payload.groupCount} native groups / ${payload.stage}`;
    case "working_selection": return `${payload.representation === "semantic_account" ? "Assessed account" : payload.representation === "owner_form" ? "Owner representation" : "Exact source"} / ${payload.obligationCount} preservation requirements / ${payload.relationshipCount} relationships`;
    case "native_group": return `Native exchange / ${payload.settledCallCount} of ${payload.callCount} calls settled / ${payload.status}`;
    case "process": return `Process ${payload.processId ?? "not started"} / ${payload.phase} / ${payload.outcome ?? "pending"}`;
    case "process_observation": return `Observation ${payload.disposition} / ${payload.returnReason ?? "waiting"} / snapshot ${payload.snapshotRevision}`;
    case "snapshot": return payload.status + " / revision " + payload.revision;
    case "transition": return (payload.from ?? "unknown") + " -> " + payload.to;
    case "scheduling": return payload.disposition + " / " + payload.rule + (payload.reason ? " / " + payload.reason : "");
    case "execution": return payload.executionKind + " / " + payload.status;
    case "dependency": return payload.condition + " / " + payload.status;
    case "transport": return payload.status + (payload.httpStatus ? " / HTTP " + payload.httpStatus : "");
    case "event": return payload.name + (payload.code ? " / " + payload.code : "");
    case "request": return payload.purpose + " / " + (payload.model ?? payload.providerId);
    case "exposure": return payload.exposed.length + " exposed / " + payload.omitted.length + " omitted";
    case "transfer": return payload.stage + " / " + (payload.operation ?? "no transform recorded");
    case "conversation": return `${payload.purpose} / ${payload.delivery} / ${payload.stage}`;
    case "definition": return payload.name + " / " + payload.revision;
    case "response": return payload.status;
    case "interval": return payload.activity + " / " + payload.phase;
    case "lifecycle": return payload.states.length + " states";
    case "flow_definition": return payload.definition.label + " / " + payload.definition.revision;
    case "flow_invocation": return payload.observation.definition.id + " / " + payload.observation.kind;
    case "flow_step": return payload.observation.stepId + " / " + payload.observation.kind;
    case "flow_constraint": return payload.observation.checkId + " / " + payload.observation.disposition;
    case "flow_link": return payload.observation.relation + (payload.observation.transitionId ? " / " + payload.observation.transitionId : "");
  }
}
