import { useEffect, useState } from "react";
import { Alert, Button, Drawer, Spin } from "antd";
import type { InspectionRecord, InspectionSubjectRef } from "@agent-anything/inspection/records";
import type { InspectionSelection } from "@agent-anything/inspection/query";
import { inspectionQuery } from "../query-client/InspectorClient.js";
import { RecordDetails } from "./RecordDetails.js";
import type { ContentTarget } from "../content/ContentLocation.js";

export function RecordedFactDrawer({recordId, scope, onClose, onContent, onRecord, onLocation, onHistory}: {
  recordId: string | null; scope: InspectionSelection | null; onClose: () => void;
  onContent: (id: string) => void; onHistory: (subject: InspectionSubjectRef) => void;
  onRecord: (id: string) => void; onLocation: (target: ContentTarget) => void;
}) {
  const [record, setRecord] = useState<InspectionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController(); setRecord(null); setError(null);
    if (recordId && scope) void inspectionQuery({...scope, kind: "get_record", recordId}, abort.signal)
      .then(result => {if (!abort.signal.aborted) {setRecord(result.records[0] ?? null); if (!result.records.length) setError("Record not observed at this snapshot.");}})
      .catch((failure: Error) => {if (!abort.signal.aborted) setError(failure.message);});
    return () => abort.abort();
  }, [recordId, scope?.sourceId, scope?.datasetId, scope?.watermark]);
  return <Drawer title="Recorded fact" open={recordId !== null} onClose={onClose} size="large">
    {error ? <Alert type="warning" title={error} /> : !record ? <Spin /> : <>
      <div className="view-toolbar"><Button onClick={() => onHistory(record.subject)}>Object history</Button><span>Snapshot {scope?.watermark}</span></div>
      <RecordDetails record={record} link={null} onContent={onContent} onRecord={onRecord} onLocation={onLocation} onSubject={onHistory} />
    </>}
  </Drawer>;
}
