import { lazy, Suspense } from "react";
import { Descriptions, Empty, Spin } from "antd";
import { FileTextOutlined, RightOutlined } from "@ant-design/icons";
import type { InspectionRecord, InspectionSubjectRef, InspectionLink } from "@agent-anything/inspection/records";
import { payloadSummary } from "./InspectionRecordSummary.js";
export { payloadSummary } from "./InspectionRecordSummary.js";
import type { ContentTarget } from "../content/ContentLocation.js";
import { RecordRelations } from "./RecordRelations.js";
import {RecoveryRecording} from "./RecoveryRecording.js";
import { RelationDetails } from "./RelationDetails.js";
const ContentViewer = lazy(async () => ({ default: (await import("../content/ContentViewer.js")).ContentViewer }));


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
    ...(record.payload.kind === "context_planning" ? [
      {key:"measurement",label:"Input measurement",children:`${record.payload.inputTokens ?? "Unknown"} tokens / ${record.payload.measurement}`},
      {key:"working-target",label:"Working target",children:record.payload.workingTarget ?? "Unknown"},
      {key:"native-bytes",label:"Native representation bytes",children:record.payload.proxyBytes},
      {key:"anchor",label:"Accepted usage anchor",children:record.payload.anchorRequestId ?? "None recorded"},
      {key:"limitations",label:"Limitations",children:record.payload.limitationCount},
    ] : []),
    ...(record.payload.kind === "working_selection" ? [
      {key:"representation",label:"Representation",children:record.payload.representation},
      {key:"order",label:"Input position",children:record.payload.position + 1},
      {key:"obligations",label:"Preservation requirements",children:record.payload.obligationCount},
      {key:"relationships",label:"Known relationships",children:record.payload.relationshipCount},
      {key:"protection",label:"Structural protection",children:record.payload.protection.join(", ") || "None recorded"},
    ] : []),
    ...(record.payload.kind === "conversation" ? [
      {key:"purpose",label:"Interaction purpose",children:record.payload.purpose},
      {key:"author",label:"Author / API role",children:`${record.payload.author} / ${record.payload.role}`},
      {key:"recipient",label:"Recipient Run",children:record.payload.recipientRunId},
      {key:"origin",label:"Origin Run",children:record.payload.originRunId ?? "Not separately recorded; inspect source references"},
      {key:"delivery",label:"Delivery",children:record.payload.delivery},
      {key:"presenter",label:"Presenter",children:record.payload.presenter},
      {key:"sources",label:"Sources",children:String(record.payload.sourceCount)},
    ] : []),
    ...(record.payload.kind === "process" ? [
      {key:"command-pid",label:"Command PID",children:String(record.payload.processId ?? "Not started")},
      {key:"helper-pid",label:"Helper PID",children:String(record.payload.helperProcessId ?? "Not used")},
      {key:"root-exit",label:"Root exit",children:record.payload.rootExit ? `${record.payload.rootExit.code ?? record.payload.rootExit.signal ?? "unknown"} / ${record.payload.rootExit.observedAt}` : "Not observed"},
      {key:"containment",label:"Process scope",children:record.payload.containment},
      {key:"capture",label:"Output capture",children:record.payload.capture},
      {key:"persistence",label:"Output persistence",children:record.payload.persistence},
    ] : []),
  ]} />{record.contents.map((item) => <button type="button" className="content-row" key={item.id} onClick={() => onContent(item.id)}><FileTextOutlined /><span className="content-row-label"><span className="content-row-name">{item.name}</span><small>{item.stage} / {item.availability}{item.truncated ? " / truncated" : ""}</small></span><RightOutlined className="content-row-arrow" /></button>)}
    {record.payload.kind === "recording_link" && <RecoveryRecording key={record.id} record={record}/>}
    <RecordRelations links={record.links} onRelation={onRelation} />
    <Suspense fallback={<Spin />}><ContentViewer text={JSON.stringify(record.payload, null, 2)} language="json" /></Suspense></>;
}
