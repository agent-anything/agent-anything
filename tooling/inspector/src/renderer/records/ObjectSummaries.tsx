import { Button, Descriptions, Empty, Table, Tabs, Tag } from "antd";
import { inspectionSubjectKey, type InspectionRecord, type InspectionSubjectRef } from "@agent-anything/inspection/records";
import type { InspectionObjectSummary } from "@agent-anything/inspection/query";
import { payloadSummary } from "./RecordDetails.js";

export function ObjectSummaries({summaries, kind, onRecord, onContent, onHistory}: {
  summaries: readonly InspectionObjectSummary[]; kind: "Requests" | "Calls" | "Scheduling";
  onRecord: (id: string) => void; onContent: (id: string) => void;
  onHistory: (subject: InspectionSubjectRef) => void;
}) {
  if (!summaries.length) return <Empty description={`No ${kind.toLowerCase()} in this Run scope`} />;
  const columns = kind === "Requests" ? [
    {title:"Request",render:(_:unknown,s:InspectionObjectSummary) => <strong>{s.label}</strong>},
    {title:"Messages / Tools",render:(_:unknown,s:InspectionObjectSummary) => {const p=s.facts.find(r=>r.payload.kind==="request")?.payload; return p?.kind==="request" ? `${p.messageCount ?? "?"} / ${p.toolCount ?? "?"}` : "Not recorded";}},
    {title:"Response",render:(_:unknown,s:InspectionObjectSummary) => {const p=[...s.facts,...s.relatedRecords].sort((a,b)=>b.commitSequence-a.commitSequence).find(r=>r.payload.kind==="response" || r.payload.kind==="transport")?.payload; return p?.kind==="response" || p?.kind==="transport" ? <Tag>{p.status}</Tag> : "No response recorded";}},
    {title:"Tokens in / out",render:(_:unknown,s:InspectionObjectSummary) => {const p=[...s.facts].reverse().find(r=>r.payload.kind==="response")?.payload;return p?.kind==="response" ? `${p.inputTokens ?? "?"} / ${p.outputTokens ?? "?"}` : "Not recorded";}},
  ] : [
    {title:"Call",render:(_:unknown,s:InspectionObjectSummary) => <strong>{s.label}</strong>},
    {title:"Scheduling",render:(_:unknown,s:InspectionObjectSummary) => {const p=[...s.facts].reverse().find(r=>r.payload.kind==="scheduling" && r.payload.rule!=="model_call_settlement")?.payload; return p?.kind==="scheduling" ? <><Tag>{p.disposition}</Tag><small>{p.rule ?? p.reason ?? ""}</small></> : "Not recorded";}},
    {title:"Action outcomes",render:(_:unknown,s:InspectionObjectSummary) => {
      const actions=[...new Map([...s.facts,...s.relatedRecords].filter(r=>r.subject.kind==="action" && r.payload.kind==="execution" && r.payload.executionKind==="action").sort((a,b)=>a.commitSequence-b.commitSequence).map(r=>[inspectionSubjectKey(r.subject),r])).values()];
      return actions.length ? actions.map(r=><Tag key={r.id}>{r.payload.kind==="execution"?r.payload.status:""}</Tag>) : "No Action settlement recorded";
    }},
  ];
  return <Table className="summary-table" rowKey={s=>inspectionSubjectKey(s.subject)} size="small" dataSource={[...summaries]} pagination={{pageSize:20,showSizeChanger:false}} columns={[
    {title:"Commit",render:(_,s)=>s.record.commitSequence,width:80}, ...columns,
    {title:"Run",render:(_,s)=><code title={s.subject.runId ?? ""}>{s.subject.runId?.slice(0,12) ?? "Unknown"}</code>,width:135},
  ]} expandable={{expandRowByClick:true,expandedRowRender:s=><SummaryDetail summary={s} onRecord={onRecord} onContent={onContent} onHistory={onHistory}/>}} />;
}

function SummaryDetail({summary, onRecord, onContent, onHistory}: {summary: InspectionObjectSummary; onRecord: (id:string)=>void; onContent:(id:string)=>void; onHistory:(subject:InspectionSubjectRef)=>void}) {
  const facts = summary.facts;
  const material=[...facts,...summary.relatedRecords.filter(record=>["provider-attempt","action","attempt"].includes(record.subject.kind))];
  const contents = [...new Map(material.flatMap(record=>record.contents.map(content=>[content.id,{content,record}] as const))).values()];
  const relations = <div className="summary-links">{summary.relatedRecords.map(record=><div key={record.id}><Button type="link" className="fact-link" onClick={()=>onRecord(record.id)}>{record.subject.kind}: {payloadSummary(record.payload)}</Button><Button size="small" onClick={()=>onHistory(record.subject)}>Object history</Button></div>)}</div>;
  const history = <Table rowKey="id" size="small" pagination={{pageSize:10,showSizeChanger:false}} dataSource={[...facts]} columns={[
    {title:"Commit",dataIndex:"commitSequence",width:80},
    {title:"Stage / fact",render:(_:unknown,r:InspectionRecord)=><Button className="fact-link" type="link" onClick={()=>onRecord(r.id)}>{payloadSummary(r.payload)}</Button>},
    {title:"Observed",render:(_:unknown,r:InspectionRecord)=>r.occurredAt ? new Date(r.occurredAt).toLocaleTimeString():"Not recorded",width:110},
  ]}/>;
  return <div className="summary-detail"><Descriptions size="small" column={1} items={[
    {key:"identity",label:summary.subject.kind,children:<code className="break-id">{summary.subject.id}</code>},
    ...facts.filter(r=>r.payload.kind === "scheduling").slice(0,1).flatMap(record=>record.payload.kind === "scheduling" ? [
      {key:"group",label:"Scheduling group",children:<code className="break-id">{record.payload.groupId ?? "Not recorded"}</code>},
      {key:"position",label:"Position",children:<span>{record.payload.position}</span>},
    ] : []),
  ]}/><Tabs items={[
    {key:"content",label:"Input / Output",children:contents.length ? <div className="summary-links">{contents.map(({content,record})=><div key={content.id}><Button onClick={()=>onContent(content.id)}>{content.name}</Button><Tag>{content.stage}</Tag><Tag>{content.availability}</Tag><Button type="link" onClick={()=>onRecord(record.id)}>Record #{record.commitSequence}</Button></div>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No content on this object; inspect linked objects"/>},
    {key:"stages",label:"Stages",children:history},
    {key:"linked",label:"Linked objects",children:relations},
  ]}/>{summary.limited && <div className="coverage-note">Summary limit reached; use Object history for all facts.</div>}</div>;
}
