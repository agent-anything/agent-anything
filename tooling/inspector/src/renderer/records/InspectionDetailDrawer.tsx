import { useEffect, useRef, useState } from "react";
import { Alert, Button, Drawer, Spin, Table } from "antd";
import type { InspectionSubjectRef } from "@agent-anything/inspection/records";
import type { InspectionReadResult, InspectionSelection } from "@agent-anything/inspection/query";
import { inspectionQuery } from "../query-client/InspectorClient.js";
import { inspectionDetailQuery, type InspectionDetailTarget } from "../navigation/InspectionDetailTarget.js";
import { RecordDetails, payloadSummary } from "./RecordDetails.js";
import { RelationDetails, SubjectIdentity } from "./RelationDetails.js";
import type { ContentTarget } from "../content/ContentLocation.js";

export function InspectionDetailDrawer({ target, scope, onClose, onTarget, onContent, onHistory, onView }: {
  target: InspectionDetailTarget | null; scope: InspectionSelection | null; onClose: () => void;
  onTarget: (target: InspectionDetailTarget) => void; onContent: (target: ContentTarget) => void;
  onHistory: (subject: InspectionSubjectRef) => void;
  onView: (subject: InspectionSubjectRef, view:"Lifecycle"|"Data Flow"|"Timeline") => void;
}) {
  const key = JSON.stringify([target, scope]);
  return <Drawer title={target?.kind === "object" ? "Related object" : target?.kind === "relation" ? "Recorded relation" : "Recorded fact"}
    open={target !== null} onClose={onClose} size="large">
    {target && scope && <DetailRead key={key} target={target} scope={scope} onTarget={onTarget} onContent={onContent} onHistory={onHistory} onView={onView} />}
  </Drawer>;
}

function DetailRead({ target, scope, onTarget, onContent, onHistory, onView }: {
  target: InspectionDetailTarget; scope: InspectionSelection;
  onTarget: (target: InspectionDetailTarget) => void; onContent: (target: ContentTarget) => void;
  onHistory: (subject: InspectionSubjectRef) => void;
  onView: (subject: InspectionSubjectRef, view:"Lifecycle"|"Data Flow"|"Timeline") => void;
}) {
  const [result, setResult] = useState<InspectionReadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const abort = useRef<AbortController | null>(null);
  async function read(after?: string) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    const request = new AbortController(); abort.current = request;
    try {
      const next = await inspectionQuery(inspectionDetailQuery(target, scope, after), request.signal);
      if (!request.signal.aborted) setResult(current => after && current
        ? { ...next, records: [...current.records, ...next.records] } : next);
    } catch (failure) { if (!request.signal.aborted) setError((failure as Error).message); }
    finally { if (!request.signal.aborted) { pending.current = false; setBusy(false); } }
  }
  useEffect(() => {
    pending.current = false;
    void read();
    return () => abort.current?.abort();
  }, []);
  const onRecord = (recordId: string) => onTarget({ kind: "record", recordId });
  const onSubject = (subject: InspectionSubjectRef) => onTarget({ kind: "object", subject });
  const record = result?.records[0] ?? null;
  const subject = target.kind === "object" ? target.subject : target.kind === "record" ? record?.subject : null;
  const link = target.kind === "relation" ? record?.links.find(item => item.id === target.linkId) : null;
  return <div className="inspection-detail">
    <div className="view-toolbar">{subject && <Button onClick={() => onHistory(subject)}>Object history</Button>}<span>Snapshot {scope.watermark}</span></div>
    {subject && ["process","process-observation"].includes(subject.kind) && <div className="view-toolbar">
      {subject.kind === "process" && <Button onClick={()=>onView(subject,"Lifecycle")}>Lifecycle</Button>}
      <Button onClick={()=>onView(subject,"Data Flow")}>Data Flow</Button>
      <Button onClick={()=>onView(subject,"Timeline")}>Timeline</Button>
    </div>}
    {target.kind === "object" && <SubjectIdentity subject={target.subject} />}
    {error && <Alert type="warning" title={error} action={<Button size="small" onClick={() => { void read(result?.next == null ? undefined : String(result.next)); }}>Retry</Button>} />}
    {!result ? !error && <Spin /> : target.kind === "object" ? <>
      {!result.records.length ? <Alert type="info" title="No records for this exact object at this snapshot." /> : <>
        <h3>Recorded facts <span>{result.records.length} loaded</span></h3>
        <Table className="related-object-facts" rowKey="id" size="small" pagination={false} dataSource={[...result.records]} columns={[
          { title: "Commit", dataIndex: "commitSequence", width: 80 },
          { title: "Fact / Content", render: (_, item) => <div className="summary-links">
            <Button className="fact-link" type="link" onClick={() => onRecord(item.id)}>{payloadSummary(item.payload)}</Button>
            {item.contents.map(content => <Button className="fact-link" key={content.id} onClick={() => onContent({ id: content.id, recordId: item.id, stage: content.stage })}>{content.name} <small>{content.stage} / {content.availability}</small></Button>)}
          </div> },
        ]} />
      </>}
      {result.next !== null && <Button loading={busy} onClick={() => { void read(String(result.next)); }}>Load more object records</Button>}
    </> : target.kind === "relation" ? link
      ? <RelationDetails link={link} onSubject={onSubject} onRecord={onRecord} onContent={onContent} />
      : <Alert type="info" title="Relation not observed in its establishing record at this snapshot." description={`${target.recordId} / ${target.linkId}`} />
    : record ? <RecordDetails record={record} link={null} onSubject={onSubject} onRecord={onRecord}
      onContent={id => onContent({ id })} onLocation={onContent}
      onRelation={item => onTarget({ kind: "relation", recordId: item.establishedBy, linkId: item.id })} />
    : <Alert type="info" title="Record not observed at this snapshot." description={target.recordId} />}
    {result?.limitations.map(value => <div className="coverage-note" key={value}>{value}</div>)}
  </div>;
}
