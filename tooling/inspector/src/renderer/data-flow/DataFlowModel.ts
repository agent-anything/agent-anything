import { inspectionSubjectKey, type InspectionLink, type InspectionSubjectRef } from "@agent-anything/inspection/records";
import type { InspectionGraph } from "@agent-anything/inspection/query";

export type DataFlowObject = InspectionGraph["nodes"][number];
export const dataRelationKinds = ["produces", "transforms", "delivers", "includes", "omits"] as const;
export type DataRelationFilter = "all" | typeof dataRelationKinds[number];

export function shortDataIdentity(subject: InspectionSubjectRef): string {
  const id = subject.runId && subject.id.startsWith(subject.runId + ":")
    ? subject.id.slice(subject.runId.length + 1) : subject.id;
  return id.length > 48 ? id.slice(0, 22) + "..." + id.slice(-19) : id;
}

export function dataObjectTitle(node: DataFlowObject): string {
  const payload = node.record?.payload;
  switch (payload?.kind) {
    case "definition": return payload.name;
    case "event": return payload.name;
    case "request": return payload.purpose + " request";
    case "transport": return payload.method + " / " + payload.status;
    case "flow_step": return payload.observation.stepId;
    case "flow_invocation": return payload.observation.definition.id;
    case "snapshot": return payload.agentId ?? "Run";
    case "transfer": return node.record!.contents[0]?.name ?? shortDataIdentity(node.subject);
    case "execution": return payload.executionKind;
    default: return node.subject.kind === "request" ? (node.subject.owner === "model-interaction" ? "Model request" : "Controller request") : node.record?.contents[0]?.name ?? node.subject.kind;
  }
}

export function defaultDataFocus(graph: InspectionGraph, runId?: string): DataFlowObject | undefined {
  const candidates = graph.nodes.filter(node => !runId || node.subject.runId === runId);
  return candidates.find(node => node.subject.kind === "request" && node.subject.owner === "model-interaction")
    ?? candidates.find(node => node.subject.kind === "request")
    ?? candidates.find(node => node.subject.kind === "contribution")
    ?? candidates[0] ?? graph.nodes[0];
}

export interface DataFlowNeighbor {
  key: string;
  node: DataFlowObject;
  links: InspectionLink[];
}

export function dataFlowNeighborhood(graph: InspectionGraph, focus: InspectionSubjectRef, filter: DataRelationFilter) {
  const key = inspectionSubjectKey(focus);
  const objects = new Map(graph.nodes.map(node => [inspectionSubjectKey(node.subject), node]));
  const incoming = new Map<string, DataFlowNeighbor>();
  const outgoing = new Map<string, DataFlowNeighbor>();
  const links = graph.links.filter(link => (filter === "all" || link.kind === filter)
    && (inspectionSubjectKey(link.from) === key || inspectionSubjectKey(link.to) === key));
  const add = (map: Map<string, DataFlowNeighbor>, subject: InspectionSubjectRef, link: InspectionLink) => {
    const neighborKey = inspectionSubjectKey(subject);
    if (neighborKey === key) return;
    let neighbor = map.get(neighborKey);
    if (!neighbor) {
      neighbor = { key: neighborKey, node: objects.get(neighborKey) ?? { subject, record: null, availability: "not_observed" }, links: [] };
      map.set(neighborKey, neighbor);
    }
    neighbor.links.push(link);
  };
  for (const link of links) {
    if (inspectionSubjectKey(link.to) === key) add(incoming, link.from, link);
    if (inspectionSubjectKey(link.from) === key) add(outgoing, link.to, link);
  }
  return { incoming: [...incoming.values()], outgoing: [...outgoing.values()], links };
}
