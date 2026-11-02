import {useEffect, useState} from "react";
import {Alert, Button, Descriptions, Table, Tag} from "antd";
import type {InspectionProcessQuery, InspectionProcessRead, InspectionReadResult} from "@agent-anything/inspection/query";
import type {InspectionRecord} from "@agent-anything/inspection/records";
import {inspectionQuery} from "../query-client/InspectorClient.js";
import {payloadSummary} from "../records/InspectionRecordSummary.js";

export function useProcessRead(query: InspectionProcessQuery | null) {
  const key = JSON.stringify(query);
  const [state, setState] = useState<{key: string; result: InspectionReadResult | null; error: string | null}>({key, result: null, error: null});
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setState({key, result: null, error: null});
    if (query) void inspectionQuery(query, abort.signal).then(result => {
      if (!abort.signal.aborted) setState({key, result, error: null});
    }).catch((error: Error) => {if (!abort.signal.aborted) setState({key, result: null, error: error.message});});
    return () => abort.abort();
  }, [key, retry]);
  return {...(state.key === key ? state : {result: null, error: null}), retry: () => setRetry(n => n + 1)};
}
export function ProcessCoverage({read}: {read: InspectionProcessRead}) {
  return <details className="process-coverage"><summary>Coverage: {read.scan === "complete" ? "fixed query boundary read" : read.scan} / {read.recordings.length} recording(s)</summary>
    <Table size="small" rowKey={r => r.selection.datasetId} pagination={false} scroll={{x: 660}} dataSource={[...read.recordings]} columns={[
      {title: "Recording", render: (_, r) => <code className="break-id">{r.selection.datasetId}</code>},
      {title: "Read / index boundary", render: (_, r) => `${r.selection.watermark} / ${read.manifest.recordings.find(m => m.datasetId === r.selection.datasetId)?.projectionWatermark ?? "unknown"}`},
      {title: "Availability / index", render: (_, r) => `${r.availability} / ${r.index}`},
      {title: "Capture", render: (_, r) => r.coverage ? `${r.coverage.status}; ${r.coverage.captured} captured; ${r.coverage.limitations.join(", ") || "no declared limitations"}` : "Unknown"},
    ]}/><p className="coverage-note">Query completion does not establish semantic completeness or absence of unrecorded work.</p>
  </details>;
}
export function ProcessPagination({read, onNext}: {read?: InspectionProcessRead; onNext: (cursor: string) => void}) {
  return read ? <div className="view-toolbar"><span>{read.page.reason} / {read.scan}</span>{read.page.next && <Button onClick={() => onNext(read.page.next!)}>Next evidence page</Button>}</div> : null;
}
export function FactSummary({record}: {record: InspectionRecord}) {
  const p = record.payload;
  if (p.kind !== "process_evidence") return <span>{payloadSummary(p)}</span>;
  return <><strong>{p.name}</strong><div className="process-fact-state"><Tag>{p.category}</Tag><span>{p.status ?? "Status not recorded"}</span></div>
    <small className="process-object-id" title={p.subject.id}>{p.subject.id}</small>
    {p.judgment && <div>Foreground: {p.judgment.foreground} / Investment: {p.judgment.investment} / Adoption: {p.judgment.adoption ?? "not recorded"}</div>}</>;
}
export function FactIdentity({record}: {record: InspectionRecord}) {
  const p = record.payload;
  return <Descriptions size="small" column={1} items={[
    {key: "id", label: "Object / revision", children: <code className="break-id">{record.subject.id} / {record.subject.revision ?? "unknown"}</code>},
    {key: "owner", label: "Owner / Run", children: <span className="break-id">{record.subject.owner} / {record.subject.runId ?? "not recorded"}</span>},
    ...(p.kind === "process_evidence" ? [
      {key: "origin", label: "Original evidence", children: <code className="break-id">{p.origin.owner} / {p.origin.id} / {p.origin.revision}</code>},
      {key: "purpose", label: "Purpose", children: p.purpose ?? "Not recorded"},
      {key: "recipient", label: "Recipient", children: p.recipient ? <span className="break-id">{p.recipient.runId} / {p.recipient.recipient} / {p.recipient.purpose}</span> : "Not recorded"},
    ] : []),
  ]}/>;
}
export function QueryError({error, retry}: {error: string | null; retry: () => void}) {
  return error ? <Alert type="error" title={error} action={<Button onClick={retry}>Retry fixed query</Button>}/> : null;
}
