import { lazy, Suspense } from "react";
import { Button, Descriptions, Empty, Spin, Tag } from "antd";
import { FileTextOutlined } from "@ant-design/icons";
import type { InspectionRecord, InspectionSubjectRef, InspectionLink, InspectionPayload } from "@agent-anything/inspection/records";
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
  }
}

export function RecordDetails({ record, link, onSubject, onRecord, onContent }: { record: InspectionRecord | null; link: InspectionLink | null; onSubject: (subject: InspectionSubjectRef) => void; onRecord: (id: string) => void; onContent: (id: string) => void }) {
  if (link) return <><Tag>{link.kind}</Tag><Descriptions column={1} size="small" items={[
    { key: "condition", label: "Condition", children: link.condition ?? "Not applicable" },
    { key: "operation", label: "Transformation", children: link.operation ?? "Not recorded" },
    { key: "from", label: "Producer", children: <Button type="link" onClick={() => onSubject(link.from)}>{link.from.id}</Button> },
    { key: "to", label: "Consumer", children: <Button type="link" onClick={() => onSubject(link.to)}>{link.to.id}</Button> },
    { key: "proof", label: "Established by", children: <Button type="link" onClick={() => onRecord(link.establishedBy)}>{link.establishedBy}</Button> },
    ...(["sourceLocation", "targetLocation"] as const).map((name) => ({ key: name, label: name === "sourceLocation" ? "Source location" : "Target location", children: link[name] ? <span>{link[name].stage}<br />{link[name].partId}<br />{link[name].jsonPointer}{link[name].contentId && <Button type="link" onClick={() => onContent(link[name]!.contentId!)}>Open recorded content</Button>}</span> : "Not recorded" })),
  ]} /><Suspense fallback={<Spin />}><ContentViewer text={JSON.stringify(link, null, 2)} language="json" /></Suspense></>;
  if (!record) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Select an object or record" />;
  return <><Descriptions column={1} size="small" items={[
    { key: "summary", label: "Fact", children: payloadSummary(record.payload) },
    { key: "kind", label: "Kind", children: record.subject.kind },
    { key: "owner", label: "Owner", children: record.subject.owner },
    { key: "id", label: "Identity", children: record.subject.id },
    { key: "revision", label: "Revision", children: record.subject.revision ?? "Not revisioned" },
    { key: "record", label: "Record", children: record.id },
    { key: "sequence", label: "Commit", children: record.commitSequence },
    { key: "time", label: "Occurred", children: record.occurredAt ?? "Not recorded" },
  ]} />{record.contents.map((item) => <button className="content-row" key={item.id} onClick={() => onContent(item.id)}><FileTextOutlined /><span>{item.name}<small>{item.stage} / {item.availability}{item.truncated ? " / truncated" : ""}</small></span></button>)}
    {record.links.filter((item) => item.kind === "trigger").map((item) => <Button key={item.id} type="link" onClick={() => onSubject(item.from)}>Trigger: {item.from.id}</Button>)}
    <Suspense fallback={<Spin />}><ContentViewer text={JSON.stringify(record.payload, null, 2)} language="json" /></Suspense></>;
}
