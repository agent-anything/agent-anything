import {useEffect, useRef, useState} from "react";
import {Alert, Button, Descriptions} from "antd";
import {ArrowRightOutlined, SearchOutlined} from "@ant-design/icons";
import {useSearchParams} from "react-router-dom";
import type {InspectionRecord} from "@agent-anything/inspection/records";
import type {InspectionSelection} from "@agent-anything/inspection/query";
import {inspectionQuery} from "../query-client/InspectorClient.js";

export function RecoveryRecording({record}: {record: InspectionRecord}) {
  const [, setParams] = useSearchParams();
  const [snapshot, setSnapshot] = useState<InspectionSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {setSnapshot(null); setError(null); setBusy(false); return () => pending.current?.abort();}, [record.id]);
  if (record.payload.kind !== "recording_link") return null;
  const {target, limitation} = record.payload;
  async function read() {
    if (!target) return;
    pending.current?.abort();
    const abort = new AbortController(); pending.current = abort; setBusy(true); setError(null);
    try {
      const result = await inspectionQuery({kind: "get_snapshot", sourceId: target.sourceId, datasetId: target.datasetId}, abort.signal);
      const scope = result.selection!;
      const history = await inspectionQuery({...scope, kind: "list_records", runId: target.runId, includeDescendants: true, limit: 1}, abort.signal);
      if (!history.records.length) throw new Error("Run evidence not observed in the linked recording.");
      if (!abort.signal.aborted) setSnapshot(scope);
    } catch (failure) {if (!abort.signal.aborted) setError((failure as Error).message);}
    finally {if (!abort.signal.aborted) setBusy(false);}
  }
  return <section aria-label="Recovery recording">
    <h3>Previous execution recording</h3>
    <Descriptions column={1} size="small" items={[
      {key:"current",label:"Current recording / establishing commit",children:`${record.subject.sourceId} / ${record.subject.datasetId} / ${record.commitSequence}`},
      {key:"target",label:"Recorded destination",children:target ? `${target.sourceId} / ${target.datasetId} / ${target.runId}` : "Not registered"},
      {key:"watermark",label:"Destination investigation snapshot",children:snapshot?.watermark ?? "Not read"},
    ]}/>
    {limitation && <Alert type="info" title={limitation}/>}
    {error && <Alert type="warning" title={error}/>}
    {target && <Button icon={<SearchOutlined/>} loading={busy} onClick={() => void read()}>Read linked recording</Button>}
    {snapshot && target && <Button icon={<ArrowRightOutlined/>} onClick={() => setParams({source:snapshot.sourceId,dataset:snapshot.datasetId,
      watermark:String(snapshot.watermark),area:"Runs",view:"Records",run:target.runId,descendants:"true"})}>Open linked recording</Button>}
  </section>;
}
