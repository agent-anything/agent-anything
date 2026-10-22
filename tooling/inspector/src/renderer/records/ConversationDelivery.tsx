import { useEffect, useRef, useState } from "react";
import { Alert, Button, Empty, Table } from "antd";
import { DownOutlined } from "@ant-design/icons";
import type { InspectionRecord, InspectionSubjectRef } from "@agent-anything/inspection/records";
import type { InspectionReadResult, InspectionSelection } from "@agent-anything/inspection/query";
import { inspectionQuery } from "../query-client/InspectorClient.js";
import { payloadSummary } from "./RecordDetails.js";

export function ConversationDelivery({scope, request, onRecord}: {
  scope: InspectionSelection; request: InspectionSubjectRef; onRecord: (id: string) => void;
}) {
  const [result, setResult] = useState<InspectionReadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  async function read(after?: string) {
    abort.current?.abort();
    const pending = new AbortController(); abort.current = pending;
    setBusy(true); setError(null);
    try {
      const next = await inspectionQuery({...scope, kind: "get_conversation_delivery", subject: request, limit: 50, ...(after ? {after} : {})}, pending.signal);
      if (!pending.signal.aborted) setResult(current => after && current ? {...next, records: [...current.records, ...next.records]} : next);
    } catch (failure) { if (!pending.signal.aborted) setError((failure as Error).message); }
    finally { if (!pending.signal.aborted) setBusy(false); }
  }
  useEffect(() => { void read(); return () => abort.current?.abort(); }, []);
  return <div className="conversation-delivery">
    {error && <Alert type="error" title={error} />}
    {!!result?.limitations.length && <div className="coverage-note">{result.limitations.join(", ")}</div>}
    <Table<InspectionRecord> rowKey="id" size="small" tableLayout="fixed" scroll={{x: 720}} loading={busy} pagination={false} dataSource={[...(result?.records ?? [])]}
      locale={{emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No recorded conversation provenance" />}} columns={[
        {title: "Order", width: 65, render: (_, record) => record.payload.kind === "conversation" ? record.payload.position + 1 : ""},
        {title: "Purpose / delivery", render: (_, record) => <Button className="fact-link" type="link" onClick={() => onRecord(record.id)}>{payloadSummary(record.payload)}</Button>},
        {title: "Author / role", render: (_, record) => record.payload.kind === "conversation" ? `${record.payload.author} / ${record.payload.role}` : ""},
        {title: "Origin / recipient", render: (_, record) => record.payload.kind === "conversation" ? <div className="break-id">{record.payload.originRunId ?? "See source references"}<br/>{record.payload.recipientRunId}</div> : ""},
        {title: "Attempt", render: (_, record) => record.payload.kind === "conversation" ? <code className="break-id">{record.payload.attemptId ?? "Not recorded"}</code> : ""},
      ]} />
    {result?.next && <Button icon={<DownOutlined />} loading={busy} onClick={() => void read(String(result.next))}>More entries</Button>}
  </div>;
}
