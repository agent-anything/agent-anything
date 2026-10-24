import {useEffect, useRef, useState} from "react";
import {Alert, Button, Empty, Table, Tag} from "antd";
import {DownOutlined} from "@ant-design/icons";
import type {InspectionRecord, InspectionSubjectRef} from "@agent-anything/inspection/records";
import type {InspectionReadResult, InspectionSelection} from "@agent-anything/inspection/query";
import {inspectionQuery} from "../query-client/InspectorClient.js";
import {payloadSummary} from "./InspectionRecordSummary.js";

export function ContextEvidence({scope, request, onRecord}: {
  scope: InspectionSelection; request: InspectionSubjectRef; onRecord(id: string): void;
}) {
  const [result, setResult] = useState<InspectionReadResult | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  async function read(after?: string) {
    abort.current?.abort(); const pending = new AbortController(); abort.current = pending;
    setBusy(true); setError(null);
    try {
      const next = await inspectionQuery({...scope, kind: "get_context_evidence", subject: request, limit: 50, ...(after ? {after} : {})}, pending.signal);
      if (!pending.signal.aborted) setResult(current => after && current ? {...next, records: [...current.records, ...next.records]} : next);
    } catch (failure) {if (!pending.signal.aborted) setError((failure as Error).message);}
    finally {if (!pending.signal.aborted) setBusy(false);}
  }
  const identity = JSON.stringify([scope, request]);
  useEffect(() => {setResult(null); void read(); return () => abort.current?.abort();}, [identity]);
  return <div className="context-evidence">
    {error && <Alert type="error" title={error}/>}
    {!!result?.limitations.length && <Alert type="warning" title={result.limitations.join(", ")}/>}
    <Table<InspectionRecord> rowKey="id" size="small" loading={busy} tableLayout="fixed" scroll={{x: 680}} pagination={false}
      dataSource={[...(result?.records ?? [])]} locale={{emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No context evidence recorded for this request"/>}}
      columns={[
        {title: "Evidence", width: 150, render: (_, record) => <Tag>{record.payload.kind.replaceAll("_", " ")}</Tag>},
        {title: "Recorded fact", render: (_, record) => <Button type="link" className="fact-link" onClick={() => onRecord(record.id)}>
          {record.payload.kind === "working_selection" ? `${record.payload.position + 1}. ${record.payload.sectionId} / ` : ""}{payloadSummary(record.payload)}</Button>},
        {title: "Constraints / uncertainty", render: (_, record) => {
          const p = record.payload;
          if (p.kind === "context_planning") return `${p.proxyBytes} native bytes; target ${p.workingTarget ?? "unknown"} tokens; ${p.limitationCount} limitations`;
          if (p.kind === "working_selection") return p.protection.length ? p.protection.join(", ") : "No structural protection recorded; semantic preservation still required";
          if (p.kind === "native_group") return p.protection;
          return "See recorded relations";
        }},
      ]}/>
    {result?.next && <Button icon={<DownOutlined/>} loading={busy} onClick={() => void read(String(result.next))}>More evidence</Button>}
  </div>;
}
