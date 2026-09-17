import { lazy, Suspense } from "react";
import { Descriptions, Empty, Spin } from "antd";
import { FileTextOutlined, RightOutlined } from "@ant-design/icons";
import type { InspectionRecord, InspectionSubjectRef, InspectionLink, InspectionPayload } from "@agent-anything/inspection/records";
import type { ContentTarget } from "../content/ContentLocation.js";
import { RecordRelations } from "./RecordRelations.js";
import { RelationDetails } from "./RelationDetails.js";
const ContentViewer = lazy(async () => ({ default: (await import("../content/ContentViewer.js")).ContentViewer }));

export function payloadSummary(payload: InspectionPayload): string {
  switch (payload.kind) {
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

export function RecordDetails({ record, link, onSubject, onRecord, onContent, onLocation, onRelation }: { record: InspectionRecord | null; link: InspectionLink | null; onSubject: (subject: InspectionSubjectRef) => void; onRecord: (id: string) => void; onContent: (id: string) => void; onLocation: (target: ContentTarget) => void; onRelation: (link: InspectionLink) => void }) {
  if (link) return <RelationDetails link={link} onSubject={onSubject} onRecord={onRecord} onContent={onLocation} />;
  if (!record) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Select an object or record" />;
  return <><Descriptions column={1} size="small" items={[
    { key: "summary", label: "Fact", children: payloadSummary(record.payload) },
    { key: "kind", label: "Kind", children: record.subject.kind },
    { key: "owner", label: "Owner", children: record.subject.owner },
    { key: "id", label: "Identity", children: record.subject.id },
    { key: "revision", label: "Revision", children: record.subject.revision ?? "Not revisioned" },
    { key: "run", label: "Run", children: record.subject.runId ?? "Not Run-scoped" },
    { key: "record", label: "Record", children: record.id },
    { key: "sequence", label: "Commit", children: record.commitSequence },
    { key: "time", label: "Occurred", children: record.occurredAt ?? "Not recorded" },
  ]} />{record.contents.map((item) => <button type="button" className="content-row" key={item.id} onClick={() => onContent(item.id)}><FileTextOutlined /><span className="content-row-label"><span className="content-row-name">{item.name}</span><small>{item.stage} / {item.availability}{item.truncated ? " / truncated" : ""}</small></span><RightOutlined className="content-row-arrow" /></button>)}
    <RecordRelations links={record.links} onRelation={onRelation} />
    <Suspense fallback={<Spin />}><ContentViewer text={JSON.stringify(record.payload, null, 2)} language="json" /></Suspense></>;
}
