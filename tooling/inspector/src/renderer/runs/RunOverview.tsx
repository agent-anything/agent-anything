import { Button, Descriptions, Empty, Table, Tag } from "antd";
import type { InspectionObjectSummary } from "@agent-anything/inspection/query";
import type { InspectionRecord } from "@agent-anything/inspection/records";
import { payloadSummary } from "../records/RecordDetails.js";

export function RunOverview({summary, onRecord, onView, onContent}: {summary: InspectionObjectSummary | undefined; onRecord: (id: string) => void; onView: (view: string) => void; onContent:(id:string)=>void}) {
  if (!summary) return <Empty description="Select a Run" />;
  const record = summary.record; const snapshot = record.payload;
  const intervals = summary.facts.filter(r => r.payload.kind === "interval" && r.payload.activity === "run");
  const entry = intervals.find(r => r.payload.kind === "interval" && r.payload.phase === "started");
  const exit = [...intervals].reverse().find(r => r.payload.kind === "interval" && r.payload.phase === "settled");
  const related = summary.relatedRecords.filter(r => ["request", "operation", "call", "control", "artifact"].includes(r.subject.kind));
  const snapshots = summary.facts.filter(r=>r.payload.kind === "snapshot");
  const firstSnapshot = snapshots[0];
  const materialRecords = [
    ...summary.relatedRecords.filter(r=>r.subject.kind === "contribution" && summary.links.some(link=>link.kind === "binding" && link.from.id === r.subject.id && link.to.id === record.subject.id)),
    ...(firstSnapshot && firstSnapshot.id !== record.id ? [firstSnapshot] : []), record,
  ];
  const material = [...new Map(materialRecords.flatMap(r=>r.contents.map(content=>[content.id,{content,record:r}] as const))).values()];
  return <div className="run-overview"><h2>{snapshot.kind === "snapshot" && snapshot.parentRunId ? "Child Run" : "Root Run"}</h2>
    <Descriptions column={1} size="small" items={[
      {key:"state",label:"Status",children:snapshot.kind === "snapshot" ? <Tag>{snapshot.status}</Tag> : "Unknown"},
      {key:"agent",label:"Agent",children:snapshot.kind === "snapshot" ? snapshot.agentId : "Not recorded"},
      {key:"id",label:"Run",children:<code className="break-id">{record.subject.id}</code>},
      {key:"parent",label:"Parent",children:snapshot.kind === "snapshot" ? snapshot.parentRunId ?? "Root" : "Unknown"},
      {key:"start",label:"Started",children:entry?.occurredAt ?? "Not recorded"},
      {key:"end",label:"Ended",children:exit?.occurredAt ?? "No settlement recorded"},
    ]}/>
    <div className="view-toolbar">{["Execution Flow", "Lifecycle", "Timeline", "Data Flow"].map(view => <Button key={view} onClick={() => onView(view)}>{view}</Button>)}</div>
    <h3>Recorded input / output</h3><div className="summary-links">{material.map(({content,record:source})=><div key={content.id}><Button onClick={()=>onContent(content.id)}>{source.payload.kind === "snapshot" ? source.id === record.id ? "Latest Run snapshot" : "Initial Run snapshot" : content.name}</Button><Tag>{content.stage}</Tag><Button type="link" onClick={()=>onRecord(source.id)}>Record #{source.commitSequence}</Button></div>)}</div>
    <h3>Run facts</h3><FactTable records={summary.facts.filter(r => ["transition", "execution", "event"].includes(r.payload.kind))} onRecord={onRecord} />
    <h3>Linked objects</h3><FactTable records={related} onRecord={onRecord} />
    {summary.limited && <div className="coverage-note">Overview is bounded. Object history contains the full paged record stream.</div>}
  </div>;
}
function FactTable({records, onRecord}: {records: readonly InspectionRecord[]; onRecord: (id: string) => void}) {
  return <Table size="small" rowKey="id" pagination={{pageSize:8,showSizeChanger:false}} dataSource={[...records]} onRow={r => ({onClick:() => onRecord(r.id)})} columns={[
    {title:"Commit",dataIndex:"commitSequence",width:80}, {title:"Object",render:(_,r) => r.subject.kind,width:100},
    {title:"Recorded fact",render:(_,r) => <Button type="link" className="fact-link" onClick={() => onRecord(r.id)}>{payloadSummary(r.payload)}</Button>},
  ]}/>;
}
