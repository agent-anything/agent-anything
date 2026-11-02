import {useEffect, useRef, useState} from "react";
import {Alert, Button, Empty, Input, InputNumber, Select, Table, Tabs, Tag} from "antd";
import {inspectionSubjectKey, type InspectionRecord, type InspectionSubjectRef} from "@agent-anything/inspection/records";
import type {InspectionProcessQuery, InspectionReadManifest, InspectionRecordingIntroduction, InspectionSelection} from "@agent-anything/inspection/query";
import {inspectionQuery} from "../query-client/InspectorClient.js";
import {processManifest, processRunIds, processViews, processSubject, readProcessValue, viewCategories, type ProcessView} from "./ProcessNavigation.js";
import {FactSummary, ProcessCoverage, ProcessPagination, QueryError, useProcessRead} from "./ProcessRead.js";
import {ProcessFocus} from "./ProcessFocus.js";
import {ProcessContent, type ProcessContentTarget} from "./ProcessContent.js";
import {ProcessMetrics} from "./ProcessMetrics.js";
import {ProcessEvaluation} from "./ProcessEvaluation.js";
import "./context-process.css";

export function ContextProcessWorkspace({selection, records, runId, params, navigate}: {
  selection: InspectionSelection; records: readonly InspectionRecord[]; runId?: string; params: URLSearchParams;
  navigate(values: Record<string, string | null>, replace?: boolean): void;
}) {
  const rawManifest = processManifest(params.get("cpManifest"));
  const sameRecording = rawManifest?.recordings[0]?.sourceId === selection.sourceId && rawManifest.recordings[0]?.datasetId === selection.datasetId;
  const manifest = sameRecording && !params.has("cpRefresh") ? rawManifest : null;
  const [error, setError] = useState<string | null>(null);
  const scopeAbort = useRef<AbortController | null>(null), nav = useRef(navigate); nav.current = navigate;
  const key = JSON.stringify(selection);
  useEffect(() => {
    if (manifest) return;
    const pending = new AbortController(); scopeAbort.current?.abort(); scopeAbort.current = pending; setError(null);
    const recordings = sameRecording ? rawManifest!.recordings.map((r, i) => ({sourceId: r.sourceId, datasetId: r.datasetId, via: r.via, ...(i === 0 ? {watermark: selection.watermark} : {})})) : [{...selection, via: null}];
    void inspectionQuery({kind: "open_process_scope", recordings}, pending.signal).then(next => {
      if (!pending.signal.aborted) nav.current({cpManifest: JSON.stringify(next.process!.manifest), cpRefresh: null, cpPage: null, cpFocusPage: null, cpMetric: null, cpMetricPage: null}, true);
    }).catch(e => {if (!pending.signal.aborted) setError(e.message);});
    return () => pending.abort();
  }, [key, !!manifest]);
  useEffect(() => () => scopeAbort.current?.abort(), []);
  async function include(sourceId: string, datasetId: string, via: InspectionRecordingIntroduction) {
    if (!manifest || manifest.recordings.some(r => r.sourceId === sourceId && r.datasetId === datasetId)) return;
    const pending = new AbortController(); scopeAbort.current?.abort(); scopeAbort.current = pending; setError(null);
    try {
      // Preserve original read and projection boundaries; only the referenced recording is opened anew.
      const read = await inspectionQuery({kind: "open_process_scope", recordings: [...manifest.recordings.map(({projectionWatermark: _, ...r}) => r), {sourceId, datasetId, via}]}, pending.signal);
      if (pending.signal.aborted) return;
      const next: InspectionReadManifest = {...read.process!.manifest, recordings: [...manifest.recordings, read.process!.manifest.recordings.at(-1)!]};
      nav.current({cpManifest: JSON.stringify(next), cpPage: null, cpFocusPage: null, cpMetric: null, cpMetricPage: null});
    } catch (e) {if (!pending.signal.aborted) setError((e as Error).message);}
  }
  return <div className="context-process-workspace" data-testid="context-process">
    {error && <Alert type="error" title={error}/>}
    {manifest ? <ProcessInvestigation key={JSON.stringify(manifest)} manifest={manifest} records={records} runId={runId} params={params} navigate={navigate} onInclude={include}/>
      : <Empty description={error ? "Process scope unavailable" : "Opening fixed process scope"}/>}
  </div>;
}

function ProcessInvestigation({manifest, records, runId, params, navigate, onInclude}: {
  manifest: InspectionReadManifest; records: readonly InspectionRecord[]; runId?: string; params: URLSearchParams;
  navigate(values: Record<string, string | null>): void;
  onInclude(sourceId: string, datasetId: string, via: InspectionRecordingIntroduction): void;
}) {
  const runIds = processRunIds(params.get("cpRuns"), runId);
  const rawView = params.get("cpView"), view: ProcessView = processViews.includes(rawView as ProcessView) ? rawView as ProcessView : processViews[0];
  const category = params.get("cpCategory") as InspectionProcessQuery["category"] | null;
  const subject = processSubject(params.get("cpFocus"));
  const content = readProcessValue<ProcessContentTarget>(params.get("cpContent"));
  const tab = ["facts", "relations", "graph", "variants"].includes(params.get("cpTab") ?? "") ? params.get("cpTab")! : "facts";
  const purpose = params.get("cpPurpose") || undefined;
  const recipient = readProcessValue<NonNullable<InspectionProcessQuery["recipient"]>>(params.get("cpRecipient"));
  const number = (name: string) => params.has(name) ? Number(params.get(name)) : undefined;
  const query: InspectionProcessQuery | null = runIds.length && view !== "Time / Cost" && view !== "Evaluation" ? {kind: view === "Adoption / Recovery" ? "get_recovery_review" : "list_context_process", manifest, runIds, section: "facts", limit: 20,
    ...(category ? {category} : {categories: viewCategories[view]}), purpose, ...(recipient ? {recipient} : {}),
    fromSequence: number("cpFrom"), throughSequence: number("cpThrough"), ...(params.get("cpPage") ? {after: params.get("cpPage")!} : {})} : null;
  const read = useProcessRead(query), process = read.result?.process;
  const groups = new Map<string, {path: InspectionSubjectRef | null; entries: NonNullable<typeof process>["entries"][number][]}>();
  for(const entry of process?.entries ?? []) {
    const path = view === "Methods / Cooperation" && entry.record.payload.kind === "process_evidence" ? entry.record.payload.executionPath ?? null : null;
    const key = path ? inspectionSubjectKey(path) : "ungrouped";
    if(!groups.has(key))groups.set(key,{path,entries:[]});
    groups.get(key)!.entries.push(entry);
  }
  if(!groups.size)groups.set("ungrouped",{path:null,entries:[]});
  const [error, setError] = useState<string | null>(null), pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const focus = (s: InspectionSubjectRef, recordId?: string) => navigate({cpFocus: JSON.stringify(s), cpRecord: recordId ?? null, cpTab: "facts", cpFocusPage: null});
  const filter = (values: Record<string, string | null>) => navigate({...values, cpPage: null});
  const setRuns=(ids:string[])=>{const next=[...new Set(ids)];if(next.length>64){setError("Run scope exceeds 64 entries; select a smaller explicit scope.");return;}navigate({cpRuns:JSON.stringify(next),cpPage:null,cpMetric:null,cpMetricPage:null});};
  const runs = [...new Map(records.filter(r => r.payload.kind === "snapshot").map(r => [r.subject.id, r])).values()];
  const options = [...new Set([...runIds, ...runs.map(r => r.subject.id), ...(subject?.runId?[subject.runId]:[])])].map(value => {
    const record = runs.find(r => r.subject.id === value), p = record?.payload;
    return {value, label: `${p?.kind === "snapshot" ? p.parentRunId ? "Child" : "Root" : "Run"} / ${value}`};
  });
  async function original(location: {sourceId: string; datasetId: string; recordId: string}) {
    const selection = manifest.recordings.find(r => r.sourceId === location.sourceId && r.datasetId === location.datasetId);
    if (!selection) {setError("Evidence recording is outside the fixed scope."); return;}
    pending.current?.abort(); const abort = new AbortController(); pending.current = abort;
    try {
      const result = await inspectionQuery({kind: "get_record", sourceId: selection.sourceId, datasetId: selection.datasetId, watermark: selection.watermark, recordId: location.recordId}, abort.signal);
      if (!abort.signal.aborted) {const record=result.records[0];if (record) focus(record.payload.kind==="process_evidence"?record.payload.subject:record.subject, location.recordId); else setError("Original observation unavailable at this boundary.");}
    } catch (e) {if (!abort.signal.aborted) setError((e as Error).message);}
  }
  return <>
    <div className="process-scope">
      <label>Explicit Run set<Select aria-label="Process Run scope" mode="multiple" value={runIds} options={options} maxTagCount={2} onChange={setRuns}/></label>
      <Button disabled={!runIds.length} onClick={() => {
        const children = runs.filter(r => r.payload.kind === "snapshot" && r.payload.parentRunId && runIds.includes(r.payload.parentRunId)).map(r => r.subject.id);
        setRuns([...runIds,...children]);
      }}>Add loaded direct children</Button>
      <span>{manifest.recordings.length} fixed recording(s)</span>
    </div>
    <details className="process-boundaries"><summary>Recording boundaries</summary>{manifest.recordings.map(r => <div className="break-id" key={r.datasetId}>{r.datasetId}: original {r.watermark}, process index {r.projectionWatermark}{r.via ? `; introduced by ${r.via.recordId}` : "; entry recording"}</div>)}</details>
    <Tabs activeKey={view} items={processViews.map(key => ({key, label: key}))} onChange={value => navigate({cpView: value, cpCategory: null, cpPage: null})}/>
    {view !== "Time / Cost" && view !== "Evaluation" && <div className="process-filters">
      <label>Evidence category<Select aria-label="Process category" allowClear value={category ?? undefined} options={viewCategories[view].map(value => ({value, label: value}))} onChange={value => filter({cpCategory: value ?? null})}/></label>
      <label>Exact purpose<Input.Search key={purpose ?? ""} aria-label="Process purpose" defaultValue={purpose} allowClear onSearch={value => filter({cpPurpose: value || null})}/></label>
      <label>Commit from<InputNumber aria-label="Process commit from" min={0} precision={0} value={number("cpFrom")} onChange={value => filter({cpFrom: value == null ? null : String(value)})}/></label>
      <label>Commit through<InputNumber aria-label="Process commit through" min={0} precision={0} value={number("cpThrough")} onChange={value => filter({cpThrough: value == null ? null : String(value)})}/></label>
      {recipient && <Tag closable onClose={() => filter({cpRecipient: null})}>Recipient: {recipient.runId} / {recipient.recipient} / {recipient.purpose}</Tag>}
      <span className="coverage-note">Commit bounds apply within each recording, not across a shared clock.</span>
    </div>}
    {error && <Alert type="error" title={error} closable onClose={() => setError(null)}/>}
    {view === "Evaluation" ? <ProcessEvaluation manifest={manifest} navigate={navigate}/> : !runIds.length ? <Empty description="Select an explicit Run scope"/> : view === "Time / Cost" ? <ProcessMetrics key={JSON.stringify([manifest, runIds])} scope={{manifest, runIds}} params={params} navigate={navigate} onRecord={location => void original(location)}/> : <>
      <QueryError error={read.error} retry={read.retry}/>
      {process && <ProcessCoverage read={process}/>}
      {[...groups].map(([key, group]) => <section key={key} className="process-path-group">
      {view === "Methods / Cooperation" && <div className="view-toolbar">{group.path ? <Button type="link" className="fact-link" onClick={()=>focus(group.path!)}>Execution path: {group.path.id}</Button> : <span>Path not declared in these observations</span>}<span>{group.entries.length} observations on this page</span></div>}
      <Table className="process-facts-table" rowKey={e => `${e.record.subject.datasetId}:${e.record.id}`} size="small" pagination={false} scroll={{x: 800}} loading={!read.result && !read.error} dataSource={group.entries} columns={[
        {title: "Commit / recording", width: 140, render: (_, e) => <span title={e.record.subject.datasetId}>{e.record.commitSequence} / {manifest.recordings.findIndex(r => r.datasetId === e.record.subject.datasetId) + 1}</span>},
        {title: "Recorded fact", render: (_, e) => <button className="process-fact-button" onClick={() => focus(e.record.payload.kind === "process_evidence" ? e.record.payload.subject : e.record.subject, e.record.id)}><FactSummary record={e.record}/></button>},
        {title: "Purpose / recipient", width: 250, render: (_, e) => {const p = e.record.payload; return p.kind === "process_evidence" ? <><span className="break-id">{p.purpose ?? "Purpose not recorded"}</span>{p.recipient && <Button type="link" className="fact-link" onClick={() => filter({cpRecipient: JSON.stringify(p.recipient)})}>{p.recipient.runId} / {p.recipient.recipient}</Button>}</> : "See original evidence";}},
        {title: "Run / revision", width: 180, render: (_, e) => <span className="break-id">{e.record.subject.runId ?? "unknown"} / {e.record.subject.revision ?? "unknown"}</span>},
      ]}/></section>)}
      <ProcessPagination read={process} onNext={cursor => navigate({cpPage: cursor})}/>
    </>}
    <ProcessFocus manifest={manifest} subject={subject} runIds={runIds} tab={tab} after={params.get("cpFocusPage") ?? undefined} recordId={params.get("cpRecord") ?? undefined}
      onClose={() => navigate({cpFocus: null, cpRecord: null, cpFocusPage: null})} onFocus={s => focus(s)} onTab={value => navigate({cpTab: value, cpFocusPage: null})} onNext={cursor => navigate({cpFocusPage: cursor})}
      onContent={target => navigate({cpContent: JSON.stringify(target)})} onInclude={onInclude} onRecord={location=>void original(location)}
      onRun={id=>setRuns([...runIds,id])}/>
    <ProcessContent manifest={manifest} target={content} onClose={() => navigate({cpContent: null})}/>
  </>;
}
