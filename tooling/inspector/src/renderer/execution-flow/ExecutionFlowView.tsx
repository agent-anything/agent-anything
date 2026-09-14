import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Alert, Button, Descriptions, Empty, Grid, Select, Segmented, Spin, Splitter, Table, Tabs, Tag, Tooltip } from "antd";
import { ArrowLeftOutlined, RightOutlined } from "@ant-design/icons";
import type { InspectionReadResult, InspectionSelection } from "@agent-anything/inspection/query";
import type { InspectionRecord, InspectionSubjectRef, InspectionLink } from "@agent-anything/inspection/records";
import { inspectionSubjectKey } from "@agent-anything/inspection/records";
import { inspectionQuery } from "../query-client/InspectorClient.js";
import { ExecutionFlowGraph } from "./ExecutionFlowGraph.js";
import { useInspectionViewState } from "../navigation/InspectionViewState.js";
const RelationGraph = lazy(async () => ({default:(await import("../graph/RelationGraph.js")).RelationGraph}));
const ContentViewer = lazy(async () => ({default:(await import("../content/ContentViewer.js")).ContentViewer}));

type Props = {scope: InspectionSelection; runId: string; paused?: boolean; params: URLSearchParams; navigate: (values: Record<string,string|null>) => void; onSubject: (subject: InspectionSubjectRef) => void; onRecord: (id: string) => void; onContent: (id: string) => void};
type Bundle = {catalog: InspectionReadResult; selected: InspectionReadResult | null; occurrences: InspectionReadResult | null; detail: InspectionReadResult | null; invocationId: string | null};
const entered = (record: InspectionRecord | undefined) => record?.payload.kind === "flow_invocation" && record.payload.observation.kind === "invocation_entered" ? record.payload.observation : null;
const stepFact = (record: InspectionRecord) => record.payload.kind === "flow_step" ? record.payload.observation : null;

export function ExecutionFlowView({scope,runId,paused=false,params,navigate,onSubject,onRecord,onContent}: Props) {
  const targetRun = params.get("flowRun") ?? runId;
  const requestedInvocation = params.get("flowInvocation");
  const occurrenceId = params.get("flowOccurrence");
  const stepId = params.get("flowStep");
  const [bundle,setBundle] = useState<Bundle|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [busy,setBusy] = useState(false);
  const [paging,setPaging] = useState(false);
  const viewKey=`flow:${scope.sourceId}:${scope.datasetId}:${targetRun}`;
  const [pane,setPane] = useInspectionViewState(viewKey+":pane","Graph");
  const [graphMode,setGraphMode] = useInspectionViewState(viewKey+":graph","Definition");
  const [detailTab,setDetailTab] = useInspectionViewState(viewKey+":tab","overview");
  const [page,setPage] = useInspectionViewState(viewKey+":page:"+(requestedInvocation ?? "root")+":"+(stepId ?? "all"),1);
  const generation = useRef(0);
  const [tall, setTall] = useState(()=>window.matchMedia("(min-height: 800px)").matches);
  useEffect(()=>{
    const query=window.matchMedia("(min-height: 800px)");
    const update=()=>setTall(query.matches);
    query.addEventListener("change",update);
    return ()=>query.removeEventListener("change",update);
  },[]);
  const desktop = Grid.useBreakpoint().xl && tall;
  const key = JSON.stringify([scope.sourceId,scope.datasetId,scope.watermark,targetRun,requestedInvocation,occurrenceId,stepId]);
  useEffect(() => {
    if (paused) return;
    const active = ++generation.current;
    const abort = new AbortController();
    setBusy(true); setError(null);
    void (async () => {
      const catalog = await inspectionQuery({...scope,kind:"get_execution_flow",runId:targetRun,limit:100},abort.signal);
      const invocationId = requestedInvocation ?? entered(catalog.records.find(record => entered(record)?.definition.id === "run-execution"))?.invocationId ?? null;
      const selected = invocationId ? await inspectionQuery({...scope,kind:"get_execution_flow",runId:targetRun,invocationId},abort.signal) : null;
      const occurrences = invocationId ? await inspectionQuery({...scope,kind:"list_flow_occurrences",runId:targetRun,invocationId,stepId:stepId ?? undefined,limit:100},abort.signal) : null;
      const detail = invocationId && occurrenceId ? await inspectionQuery({...scope,kind:"get_flow_occurrence",runId:targetRun,invocationId,occurrenceId,limit:100},abort.signal) : null;
      if (active === generation.current && !abort.signal.aborted) setBundle({catalog,selected,occurrences,detail,invocationId});
    })().catch(failure => {if (!abort.signal.aborted && active === generation.current) setError(String(failure.message));}).finally(() => {if (active === generation.current) setBusy(false);});
    return () => { abort.abort(); ++generation.current; };
  }, [key,paused]);
  const flow = bundle?.selected?.flow;
  const definition = flow?.definition;
  const selectedRecords = bundle?.detail?.records ?? [];
  const entry = selectedRecords.find(record => stepFact(record)?.kind === "step_entered");
  const exit = selectedRecords.find(record => stepFact(record)?.kind === "step_exited");
  const exitFact = exit ? stepFact(exit) : null;
  const constraints = selectedRecords.filter(record => record.payload.kind === "flow_constraint");
  const links = bundle?.detail?.flow?.links ?? bundle?.selected?.flow?.links ?? [];
  const occurrenceRecords = bundle?.occurrences?.records.filter(record => stepFact(record)?.kind === "step_entered") ?? [];
  const navigateTo = (invocation: string, childRun = targetRun, occurrence: string|null = null) => navigate({flowRun:childRun,flowInvocation:invocation,flowOccurrence:occurrence,flowStep:null});
  async function follow(subject: InspectionSubjectRef) {
    const active = generation.current;
    setError(null);
    try {
      const read = await inspectionQuery({...scope,kind:"get_subject",subject});
      if (active !== generation.current) return;
      const payload = read.records[0]?.payload;
      if (payload && (payload.kind === "flow_invocation" || payload.kind === "flow_step")) {
        navigateTo(payload.observation.invocationId,payload.observation.runId,payload.kind === "flow_step" ? payload.observation.stepExecutionId : null);
      } else if (subject.kind === "run") navigate({flowRun:subject.id,flowInvocation:null,flowOccurrence:null,flowStep:null});
      else if (subject.kind.startsWith("flow-")) setError("The linked occurrence was not recorded at this snapshot.");
      else onSubject(subject);
    } catch (failure) {if (active === generation.current) setError((failure as Error).message);}
  }
  async function more(target: "catalog"|"occurrences"|"detail") {
    const current = bundle?.[target];
    if (!current?.next || paging || busy) return;
    const active = generation.current; setPaging(true);
    try {
      const next = await inspectionQuery({...scope,kind:target === "catalog" ? "get_execution_flow" : target === "occurrences" ? "list_flow_occurrences" : "get_flow_occurrence",runId:targetRun,invocationId:target === "catalog" ? undefined : bundle?.invocationId ?? undefined,occurrenceId:target === "detail" ? occurrenceId ?? undefined : undefined,stepId:target === "occurrences" ? stepId ?? undefined : undefined,cursor:String(current.next),limit:100});
      if (active === generation.current) setBundle(value => value ? {...value,[target]:{
        ...next, records:[...current.records,...next.records],
        ...(next.flow ? {flow:{...next.flow,occurrences:[...current.flow?.occurrences ?? [], ...next.flow.occurrences ?? []],links:[...new Map([...(current.flow?.links ?? []),...next.flow.links].map(link => [link.id,link])).values()]}} : {}),
      }} : value);
    } catch (failure) {if(active === generation.current) setError((failure as Error).message);} finally {setPaging(false);}
  }
  const coverage = bundle?.detail?.flow?.occurrence;
  const relatedRecords = bundle?.detail?.flow?.relatedRecords ?? bundle?.selected?.flow?.relatedRecords ?? [];
  const relatedLabel = (subject: InspectionSubjectRef) => {
    const record = relatedRecords.find(r=>r.subject.id === subject.id);
    if (record?.payload.kind === "flow_step") return record.payload.observation.stepId;
    if (record?.payload.kind === "flow_invocation") return record.payload.observation.definition.id;
    return `${subject.kind} / ${subject.id.slice(0,12)}`;
  };
  const caller = bundle?.selected?.flow?.ancestry?.[0];
  const relationLabel = (link: InspectionLink) => {
    const outgoing = link.from.id === (occurrenceId ?? bundle?.invocationId);
    if (link.kind === "next") return outgoing ? "Next occurrence" : "Previous occurrence";
    if (link.kind === "call") return outgoing ? "Called flow" : "Called from";
    if (link.kind === "return") return outgoing ? "Return to" : "Returned from";
    return `${link.kind} / ${outgoing ? "outgoing" : "incoming"}`;
  };
  const checks = <><div className="check-coverage">{coverage?.checks.map(check=><Tag key={check.id} color={check.availability==="not_observed"?"warning":"default"}>{check.id}: {check.availability}</Tag>)}</div><Table size="small" rowKey="id" pagination={false} dataSource={constraints} columns={[
    {title:"Check",render:(_value,record) => record.payload.kind === "flow_constraint" ? record.payload.observation.checkId : ""},
    {title:"Outcome",render:(_value,record) => record.payload.kind === "flow_constraint" ? <Tag color={record.payload.observation.disposition === "not_satisfied" ? "warning" : "default"}>{record.payload.observation.disposition}</Tag> : ""},
    {title:"Recorded basis",render:(_value,record) => record.payload.kind === "flow_constraint" ? <pre className="flow-basis">{JSON.stringify(record.payload.observation.basis,null,2)}</pre> : ""},
  ]} /></>;
  const linkTarget = (link: InspectionLink) => link.from.id === occurrenceId || link.from.id === bundle?.invocationId ? link.to : link.from;
  const details = <div className="flow-details">{occurrenceId ? <Tabs activeKey={detailTab} onChange={setDetailTab} items={[
    {key:"overview",label:"Overview",children:<><Descriptions column={1} size="small" items={[
      {key:"step",label:"Step",children:entry ? definition?.steps.find(step => step.id === stepFact(entry)?.stepId)?.label ?? stepFact(entry)?.stepId : "Entry not observed"},
      {key:"status",label:"Disposition",children:exitFact?.kind === "step_exited" ? exitFact.disposition : "Exit not observed at snapshot"},
      {key:"entry",label:"Entered",children:entry?.occurredAt ?? "Not observed"},
      {key:"exit",label:"Exited",children:exit?.occurredAt ?? "Not observed"},
      {key:"identity",label:"Occurrence",children:occurrenceId},
      {key:"coverage",label:"Coverage",children:coverage?.status ?? "Unknown"},
    ]} />{selectedRecords.map(record => { const fact = stepFact(record); return fact ? <pre key={record.id} className="flow-basis">{JSON.stringify({kind:fact.kind,...fact.basis},null,2)}</pre> : null; })}</>},
    {key:"checks",label:`Checks (${constraints.length})`,children:checks},
    {key:"io",label:"Inputs / Outputs",children:<>{coverage?.references.map((item,index)=><div key={`${item.sourceRecordId}:${item.position}:${index}`} className="flow-reference">
      <div><Tag>{item.role}</Tag><Tag color={item.availability === "present" ? "default" : "warning"}>{item.availability}</Tag><span>{item.reference.kind}</span></div>
      <code className="break-id">{item.reference.id}</code>
      {item.recordId && <Button size="small" onClick={()=>onRecord(item.recordId!)}>Open referenced record</Button>}
      <div className="summary-links">{item.contents.map(content=><Button key={content.id} onClick={()=>onContent(content.id)}>{content.name}<Tag>{content.availability}</Tag></Button>)}</div>
    </div>)}{!coverage?.references.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No input/output references recorded" />}</>},
    {key:"records",label:"Records",children:<Suspense fallback={<Spin />}><ContentViewer text={JSON.stringify(selectedRecords,null,2)} language="json" /></Suspense>},
  ]} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Select a recorded occurrence" />}
    {links.length > 0 && <div className="flow-relations"><h3>Recorded relationships</h3>{links.map(link => <Button key={link.id} type="link" icon={<RightOutlined />} onClick={() => {void follow(linkTarget(link));}}>{relationLabel(link)}: {relatedLabel(linkTarget(link))}</Button>)}</div>}
    {bundle?.detail?.next && <Button onClick={() => {void more("detail");}} loading={paging}>More occurrence facts</Button>}
  </div>;
  const occurrences = <div className="flow-occurrences"><div className="view-toolbar"><span>{stepId ? definition?.steps.find(step => step.id === stepId)?.label ?? stepId : "All steps"}</span>{stepId && <Button size="small" onClick={() => navigate({flowStep:null})}>All steps</Button>}<span>{occurrenceRecords.length} loaded occurrences</span></div><Table size="small" rowKey="id" scroll={{x:610}} pagination={{pageSize:15,showSizeChanger:false,current:Math.min(page,Math.max(1,Math.ceil(occurrenceRecords.length/15))),onChange:setPage}} dataSource={occurrenceRecords} rowClassName={record => stepFact(record)?.stepExecutionId === occurrenceId ? "record-selected" : ""} onRow={record => ({onClick:() => {navigate({flowInvocation:bundle?.invocationId ?? null,flowOccurrence:stepFact(record)!.stepExecutionId});setPane("Details");}})} columns={[
    {title:"Commit",dataIndex:"commitSequence",width:75},
    {title:"Step",render:(_value,record) => definition?.steps.find(step => step.id === stepFact(record)?.stepId)?.label ?? stepFact(record)?.stepId},
    {title:"Result",width:115,render:(_value,record) => {const item=bundle?.occurrences?.flow?.occurrences?.find(item=>item.entry.id===record.id);return <><Tag>{item?.disposition ?? "Unknown"}</Tag>{item?.branch && <small className="table-owner">{item.branch}</small>}</>;}},
    {title:"Checks",width:75,render:(_value,record) => {const item=bundle?.occurrences?.flow?.occurrences?.find(item=>item.entry.id===record.id);return item ? <span>{item.checkCount}{item.issueCount ? ` / ${item.issueCount} not satisfied` : ""}</span> : "?";}},
    {title:"Time",width:85,render:(_value,record) => {const ms=bundle?.occurrences?.flow?.occurrences?.find(item=>item.entry.id===record.id)?.durationMs;return ms == null ? "Unknown" : ms < 1000 ? `${ms} ms` : `${(ms/1000).toFixed(1)} s`;}},
    {title:"Entered",width:105,render:(_value,record) => record.occurredAt ? new Date(record.occurredAt).toLocaleTimeString() : "Unknown"},
  ]} />{bundle?.occurrences?.next && <Button loading={paging} onClick={() => {void more("occurrences");}}>More occurrences</Button>}</div>;
  const definitionGraph = flow && definition ? <ExecutionFlowGraph viewKey={viewKey+":"+bundle?.invocationId} flow={flow} occurrenceLinks={bundle?.detail?.flow?.links} occurrenceId={occurrenceId} relatedRecords={relatedRecords} selected={stepId ?? (entry ? stepFact(entry)?.stepId ?? null : null)} onSelect={id => {navigate({flowInvocation:bundle?.invocationId ?? null,flowStep:id,flowOccurrence:null});setPane("Occurrences");}} /> : <Empty description="Flow definition not recorded at this snapshot" />;
  const neighbors = [...new Map(links.flatMap(link=>[link.from,link.to]).map(ref=>[inspectionSubjectKey(ref),ref])).values()];
  const neighborhood = {nodes:neighbors.map(subject=>{const record=relatedRecords.find(record=>inspectionSubjectKey(record.subject)===inspectionSubjectKey(subject)) ?? null;return {subject,record,availability:record ? "present" as const : "not_observed" as const};}),links,limited:false,scope:"selected_neighborhood" as const,nodeLimit:512,edgeLimit:256};
  const graph = <div className="flow-graph-panel"><Segmented aria-label="Flow graph mode" options={["Definition","Occurrence"]} value={graphMode} onChange={setGraphMode}/><div className="flow-graph-body">{graphMode === "Definition" ? definitionGraph : occurrenceId ? <Suspense fallback={<Spin/>}><RelationGraph graph={neighborhood} selected={entry?.subject ?? null} onSelect={subject=>{void follow(subject);}} onLink={id=>{const link=links.find(link=>link.id===id);if(link)onRecord(link.establishedBy);}}/></Suspense> : <Empty description="Select an occurrence to inspect its recorded neighbors"/>}</div></div>;
  const missing = [...new Set([...(bundle?.catalog.limitations ?? []),...(bundle?.selected?.limitations ?? []),...(bundle?.detail?.limitations ?? [])])];
  return <div className="execution-flow-view" aria-busy={busy || paused}><div className="view-toolbar"><Tooltip title="Back to recorded caller"><Button aria-label="Back to caller" disabled={!caller} icon={<ArrowLeftOutlined />} onClick={() => {if(caller) void follow(caller.subject);}} /></Tooltip><Select aria-label="Flow invocation" showSearch optionFilterProp="label" value={bundle?.invocationId ?? undefined} placeholder="Recorded invocation" options={bundle?.catalog.records.flatMap(record => {const fact=entered(record);return fact ? [{value:fact.invocationId,label:`${fact.definition.owner} / ${fact.definition.id} / #${record.commitSequence}`}] : [];}) ?? []} onChange={value => navigateTo(value)} />{busy && <Spin size="small" />}{bundle?.catalog.next && <Button size="small" loading={paging} onClick={() => {void more("catalog");}}>More invocations</Button>}</div>
    {bundle?.selected?.flow?.ancestry?.length ? <div className="flow-ancestry">{[...bundle.selected.flow.ancestry].reverse().map(record=><Button size="small" type="link" key={record.id} onClick={()=>{void follow(record.subject);}}>{record.payload.kind === "flow_step" ? record.payload.observation.stepId : record.subject.kind}</Button>)}</div> : null}
    {definition && <div className="flow-definition-heading"><strong>{definition.label}</strong><Tag>{definition.owner}</Tag><span>Revision {definition.revision}</span><Tooltip title={definition.contentDigest}><span className="flow-digest">{definition.contentDigest.slice(0,20)}</span></Tooltip></div>}
    {targetRun !== runId && <Tag color="processing">Run: {targetRun}</Tag>}{error && <Alert type="error" title={error} />}{missing.length > 0 && <Alert type="warning" title={missing.join(" / ")} />}
    {desktop ? <Splitter orientation="vertical" className="flow-splitter"><Splitter.Panel defaultSize="52%" min={220}>{graph}</Splitter.Panel><Splitter.Panel min={190}><Splitter><Splitter.Panel defaultSize="45%" min={210}>{occurrences}</Splitter.Panel><Splitter.Panel min={250}>{details}</Splitter.Panel></Splitter></Splitter.Panel></Splitter> : <><Segmented aria-label="Execution flow panel" options={["Graph","Occurrences","Details"]} value={pane} onChange={setPane} /><div className="flow-narrow-panel">{pane === "Graph" ? graph : pane === "Occurrences" ? occurrences : details}</div></>}
  </div>;
}
