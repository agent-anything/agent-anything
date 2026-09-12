import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Alert, Button, Descriptions, Empty, Grid, Select, Segmented, Spin, Splitter, Table, Tabs, Tag, Tooltip } from "antd";
import { ArrowLeftOutlined, RightOutlined, FileTextOutlined } from "@ant-design/icons";
import type { InspectionReadResult, InspectionSelection } from "@agent-anything/inspection/query";
import type { InspectionRecord, InspectionSubjectRef, InspectionLink } from "@agent-anything/inspection/records";
import { inspectionQuery } from "../query-client/InspectorClient.js";
import { ExecutionFlowGraph } from "./ExecutionFlowGraph.js";
const ContentViewer = lazy(async () => ({default:(await import("../content/ContentViewer.js")).ContentViewer}));

type Props = {scope: InspectionSelection; runId: string; paused?: boolean; params: URLSearchParams; navigate: (values: Record<string,string|null>) => void; onSubject: (subject: InspectionSubjectRef) => void; onContent: (id: string) => void};
type Bundle = {catalog: InspectionReadResult; selected: InspectionReadResult | null; occurrences: InspectionReadResult | null; detail: InspectionReadResult | null; invocationId: string | null};
const entered = (record: InspectionRecord | undefined) => record?.payload.kind === "flow_invocation" && record.payload.observation.kind === "invocation_entered" ? record.payload.observation : null;
const stepFact = (record: InspectionRecord) => record.payload.kind === "flow_step" ? record.payload.observation : null;

export function ExecutionFlowView({scope,runId,paused=false,params,navigate,onSubject,onContent}: Props) {
  const targetRun = params.get("flowRun") ?? runId;
  const requestedInvocation = params.get("flowInvocation");
  const occurrenceId = params.get("flowOccurrence");
  const stepId = params.get("flowStep");
  const [bundle,setBundle] = useState<Bundle|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [busy,setBusy] = useState(false);
  const [paging,setPaging] = useState(false);
  const [pane,setPane] = useState("Graph");
  const generation = useRef(0);
  const desktop = Grid.useBreakpoint().xl;
  const key = JSON.stringify([scope.sourceId,scope.datasetId,scope.watermark,targetRun,requestedInvocation,occurrenceId,stepId]);
  useEffect(() => {
    if (paused) return;
    const active = ++generation.current;
    const abort = new AbortController();
    setBusy(true); setError(null);
    void (async () => {
      const catalog = await inspectionQuery({...scope,kind:"get_execution_flow",runId:targetRun,limit:100},abort.signal);
      const invocationId = requestedInvocation ?? entered(catalog.records.find(record => entered(record)?.definition.id === "run-execution") ?? catalog.records[0]!)?.invocationId ?? null;
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
        ...(next.flow ? {flow:{...next.flow,links:[...new Map([...(current.flow?.links ?? []),...next.flow.links].map(link => [link.id,link])).values()]}} : {}),
      }} : value);
    } catch (failure) {if(active === generation.current) setError((failure as Error).message);} finally {setPaging(false);}
  }
  const sourceRefs = selectedRecords.flatMap(record => {
    const fact = stepFact(record);
    return fact ? (fact.kind === "step_entered" ? fact.inputs.map(ref => ({ref,direction:"Input"})) : fact.outputs.map(ref => ({ref,direction:"Output"}))) : [];
  });
  const checks = <Table size="small" rowKey="id" pagination={false} dataSource={constraints} columns={[
    {title:"Check",render:(_value,record) => record.payload.kind === "flow_constraint" ? record.payload.observation.checkId : ""},
    {title:"Outcome",render:(_value,record) => record.payload.kind === "flow_constraint" ? <Tag color={record.payload.observation.disposition === "not_satisfied" ? "warning" : "default"}>{record.payload.observation.disposition}</Tag> : ""},
    {title:"Recorded basis",render:(_value,record) => record.payload.kind === "flow_constraint" ? <pre className="flow-basis">{JSON.stringify(record.payload.observation.basis,null,2)}</pre> : ""},
  ]} />;
  const linkTarget = (link: InspectionLink) => link.from.id === occurrenceId || link.from.id === bundle?.invocationId ? link.to : link.from;
  const details = <div className="flow-details">{occurrenceId ? <Tabs items={[
    {key:"overview",label:"Overview",children:<><Descriptions column={1} size="small" items={[
      {key:"step",label:"Step",children:entry ? definition?.steps.find(step => step.id === stepFact(entry)?.stepId)?.label ?? stepFact(entry)?.stepId : "Entry not observed"},
      {key:"status",label:"Disposition",children:exitFact?.kind === "step_exited" ? exitFact.disposition : "Exit not observed at snapshot"},
      {key:"entry",label:"Entered",children:entry?.occurredAt ?? "Not observed"},
      {key:"exit",label:"Exited",children:exit?.occurredAt ?? "Not observed"},
      {key:"identity",label:"Occurrence",children:occurrenceId},
    ]} />{selectedRecords.map(record => { const fact = stepFact(record); return fact ? <pre key={record.id} className="flow-basis">{JSON.stringify({kind:fact.kind,...fact.basis},null,2)}</pre> : null; })}</>},
    {key:"checks",label:`Checks (${constraints.length})`,children:checks},
    {key:"io",label:"Inputs / Outputs",children:<>{sourceRefs.map(({ref,direction},index) => <div key={index} className="flow-reference"><Tag>{direction}</Tag><Button type="link" onClick={() => onSubject({sourceId:scope.sourceId,datasetId:scope.datasetId,owner:ref.owner,kind:ref.kind as InspectionSubjectRef["kind"],id:ref.id,revision:ref.revision,runId:ref.runId ?? targetRun})}>{ref.kind}: {ref.id}</Button>{ref.contentId && <Tooltip title="Open content"><Button icon={<FileTextOutlined />} onClick={() => onContent(ref.contentId!)} /></Tooltip>}</div>)}{!sourceRefs.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No input/output references recorded" />}</>},
    {key:"records",label:"Records",children:<Suspense fallback={<Spin />}><ContentViewer text={JSON.stringify(selectedRecords,null,2)} language="json" /></Suspense>},
  ]} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Select a recorded occurrence" />}
    {links.length > 0 && <div className="flow-relations"><h3>Recorded relationships</h3>{links.map(link => <Button key={link.id} type="link" icon={<RightOutlined />} onClick={() => {void follow(linkTarget(link));}}>{link.kind}: {linkTarget(link).kind} / {linkTarget(link).id}</Button>)}</div>}
    {bundle?.detail?.next && <Button onClick={() => {void more("detail");}} loading={paging}>More occurrence facts</Button>}
  </div>;
  const occurrences = <div className="flow-occurrences"><div className="view-toolbar"><span>{stepId ? definition?.steps.find(step => step.id === stepId)?.label ?? stepId : "All steps"}</span>{stepId && <Button size="small" onClick={() => navigate({flowStep:null})}>All steps</Button>}<span>{occurrenceRecords.length} loaded occurrences</span></div><Table size="small" rowKey="id" pagination={{pageSize:15,showSizeChanger:false}} dataSource={occurrenceRecords} rowClassName={record => stepFact(record)?.stepExecutionId === occurrenceId ? "record-selected" : ""} onRow={record => ({onClick:() => {navigate({flowInvocation:bundle?.invocationId ?? null,flowOccurrence:stepFact(record)!.stepExecutionId});setPane("Details");}})} columns={[
    {title:"Commit",dataIndex:"commitSequence",width:75},
    {title:"Step",render:(_value,record) => definition?.steps.find(step => step.id === stepFact(record)?.stepId)?.label ?? stepFact(record)?.stepId},
    {title:"Entered",width:105,render:(_value,record) => record.occurredAt ? new Date(record.occurredAt).toLocaleTimeString() : "Unknown"},
  ]} />{bundle?.occurrences?.next && <Button loading={paging} onClick={() => {void more("occurrences");}}>More occurrences</Button>}</div>;
  const graph = flow && definition ? <ExecutionFlowGraph flow={flow} selected={stepId ?? (entry ? stepFact(entry)?.stepId ?? null : null)} onSelect={id => {navigate({flowInvocation:bundle?.invocationId ?? null,flowStep:id,flowOccurrence:null});setPane("Occurrences");}} /> : <Empty description="Flow definition not recorded at this snapshot" />;
  const missing = [...new Set([...(bundle?.catalog.limitations ?? []),...(bundle?.selected?.limitations ?? []),...(bundle?.detail?.limitations ?? [])])];
  return <div className="execution-flow-view" aria-busy={busy || paused}><div className="view-toolbar"><Tooltip title="Previous investigation"><Button aria-label="Previous flow" icon={<ArrowLeftOutlined />} onClick={() => history.back()} /></Tooltip><Select aria-label="Flow invocation" showSearch optionFilterProp="label" value={bundle?.invocationId ?? undefined} placeholder="Recorded invocation" options={bundle?.catalog.records.flatMap(record => {const fact=entered(record);return fact ? [{value:fact.invocationId,label:`${fact.definition.owner} / ${fact.definition.id} / #${record.commitSequence}`}] : [];}) ?? []} onChange={value => navigateTo(value)} />{busy && <Spin size="small" />}{bundle?.catalog.next && <Button size="small" loading={paging} onClick={() => {void more("catalog");}}>More invocations</Button>}</div>
    {definition && <div className="flow-definition-heading"><strong>{definition.label}</strong><Tag>{definition.owner}</Tag><span>Revision {definition.revision}</span><Tooltip title={definition.contentDigest}><span className="flow-digest">{definition.contentDigest.slice(0,20)}</span></Tooltip></div>}
    {targetRun !== runId && <Tag color="processing">Run: {targetRun}</Tag>}{error && <Alert type="error" title={error} />}{missing.length > 0 && <Alert type="warning" title={missing.join(" / ")} />}
    {desktop ? <Splitter orientation="vertical" className="flow-splitter"><Splitter.Panel defaultSize="52%" min={220}>{graph}</Splitter.Panel><Splitter.Panel min={190}><Splitter><Splitter.Panel defaultSize="45%" min={210}>{occurrences}</Splitter.Panel><Splitter.Panel min={250}>{details}</Splitter.Panel></Splitter></Splitter.Panel></Splitter> : <><Segmented aria-label="Execution flow panel" options={["Graph","Occurrences","Details"]} value={pane} onChange={setPane} /><div className="flow-narrow-panel">{pane === "Graph" ? graph : pane === "Occurrences" ? occurrences : details}</div></>}
  </div>;
}
