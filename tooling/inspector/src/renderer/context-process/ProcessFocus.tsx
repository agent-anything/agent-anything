import {lazy, Suspense} from "react";
import {Alert, Button, Drawer, Empty, Spin, Table, Tabs, Tag} from "antd";
import {inspectionSubjectKey, type InspectionSubjectRef, type InspectionRecord} from "@agent-anything/inspection/records";
import type {InspectionReadManifest, InspectionProcessEntry, InspectionProcessRelation, InspectionRecordingIntroduction, InspectionGraph} from "@agent-anything/inspection/query";
import {CanvasFrame} from "../canvas/CanvasFrame.js";
import {FactIdentity, FactSummary, ProcessCoverage, ProcessPagination, QueryError, useProcessRead} from "./ProcessRead.js";
import type {ProcessContentTarget} from "./ProcessContent.js";
const RelationGraph = lazy(async () => ({default: (await import("../graph/RelationGraph.js")).RelationGraph}));

export interface ProcessFocusProps {
  manifest: InspectionReadManifest; subject: InspectionSubjectRef | null; runIds: readonly string[];
  tab: string; after?: string; recordId?: string;
  onClose(): void; onFocus(subject: InspectionSubjectRef): void; onTab(tab: string): void; onNext(cursor: string): void;
  onContent(target: ProcessContentTarget): void;
  onRecord(location: {sourceId:string;datasetId:string;recordId:string}): void;
  onRun(runId:string): void;
  onInclude(sourceId: string, datasetId: string, via: InspectionRecordingIntroduction): void;
}
export function ProcessFocus(props: ProcessFocusProps) {
  return <Drawer title="Process evidence" open={props.subject !== null} onClose={props.onClose} size="large" destroyOnHidden>
    {props.subject && <FocusRead key={JSON.stringify([props.manifest, props.subject, props.tab, props.after, props.recordId])} {...props} subject={props.subject}/>}
  </Drawer>;
}
function FocusRead(props: ProcessFocusProps & {subject: InspectionSubjectRef}) {
  const {manifest, subject, tab, after, onFocus, onContent, onNext, onInclude} = props;
  const facts = useProcessRead({kind: "list_context_process", manifest, subject, section: "facts", recordId: props.recordId, limit: 20, ...(tab === "facts" && after ? {after} : {})});
  const selected = facts.result?.process?.entries.find(e => e.record.id === props.recordId) ?? facts.result?.process?.entries[0];
  const data = useProcessRead(tab === "facts" || !facts.result || (tab === "variants" && !selected?.identity) ? null : {kind: "list_context_process", manifest, section: tab === "variants" ? "variants" : "relationships",
    ...((tab === "variants" || props.recordId) && selected?.identity ? {evidence: selected.identity} : {subject}), limit: 20, ...(after ? {after} : {})});
  const read = tab === "facts" ? facts : data, process = read.result?.process;
  const external = !manifest.recordings.some(r => r.sourceId === subject.sourceId && r.datasetId === subject.datasetId);
  const graphRelations = process?.relationships ?? [];
  const nodes = new Map<string, InspectionGraph["nodes"][number]>();
  for (const relation of graphRelations) for (const endpoint of [relation.source, relation.target]) nodes.set(inspectionSubjectKey(endpoint.subject), {subject: endpoint.subject, record: null, availability: endpoint.availability === "recorded" ? "present" : "not_observed"});
  const graph: InspectionGraph = {nodes: [...nodes.values()], links: graphRelations.map(r => r.link), limited: process?.scan !== "complete", scope: "selected_neighborhood", nodeLimit: 40, edgeLimit: 20};
  return <div className="process-focus">
    <code className="break-id">{subject.owner} / {subject.kind} / {subject.id} / {subject.revision ?? "revision unknown"}</code>
    {props.recordId && <div className="view-toolbar"><span>Exact observation: {props.recordId}</span><Button onClick={() => onFocus(subject)}>All facts for this object</Button></div>}
    {(external || (subject.runId && !props.runIds.includes(subject.runId))) && <Alert type="info" title={external ? "External recording: use the recorded relation to explicitly include it." : "Focus is outside the selected Run set. Aggregate scope is unchanged."}/>}
    {!external && subject.runId && !props.runIds.includes(subject.runId) && <Button onClick={()=>props.onRun(subject.runId!)}>Add focused Run to investigation scope</Button>}
    <Tabs activeKey={tab} onChange={props.onTab} items={[{key: "facts", label: "Facts / content"}, {key: "relations", label: "Relationships"}, {key: "graph", label: "Local graph"}, ...(selected?.identity ? [{key: "variants", label: "Evidence variants"}] : [])]}/>
    <QueryError error={facts.error ?? read.error} retry={read.retry}/>
    {process && <ProcessCoverage read={process}/>}
    {!process ? tab === "variants" && facts.result && !selected?.identity ? <Alert type="info" title="No original evidence identity is available for variant comparison."/> : !(read.error || facts.error) && <Spin/> : tab === "facts" ? <>
      {!process.entries.length && <Empty description={`No facts at this boundary (${process.anchor?.availability ?? "unknown"})`}/>}
      {process.entries.map(entry => <ProcessFact key={entry.record.id} entry={entry} onContent={onContent} onInclude={onInclude}/>)}
    </> : tab === "variants" ? <Table size="small" rowKey={v => `${v.selection.datasetId}:${v.recordId}`} pagination={false} dataSource={[...process.variants]} columns={[
      {title: "Original revision", render: (_, v) => v.identity.revision}, {title: "Variant digest", render: (_, v) => <code className="break-id">{v.digest}</code>},
      {title: "Recording / commit", render: (_, v) => <Button type="link" className="fact-link" onClick={()=>props.onRecord({...v.selection,recordId:v.recordId})}>{v.selection.datasetId} / {v.firstSequence}</Button>},
    ]}/> : tab === "graph" ? graph.nodes.length ? <><CanvasFrame title="Process relations"><Suspense fallback={<Spin/>}><RelationGraph graph={graph} selected={subject} onSelect={onFocus} onLink={id => document.getElementById(`relation-${id}`)?.scrollIntoView({block: "center"})}/></Suspense></CanvasFrame><div className="coverage-note">Edges show recorded relation types. Order does not imply dependency; overlap is measured separately.</div><RelationRows relationships={graphRelations} {...props}/></> : <Empty description="No recorded relations in this page"/>
      : <RelationRows relationships={graphRelations} {...props}/>}
    <ProcessPagination read={process} onNext={onNext}/>
  </div>;
}
function ProcessFact({entry, onContent, onInclude}: {entry: InspectionProcessEntry; onContent: ProcessFocusProps["onContent"]; onInclude: ProcessFocusProps["onInclude"]}) {
  const {record, relationCoverage} = entry, p = record.payload;
  const open = (contentId: string) => onContent({sourceId: record.subject.sourceId, datasetId: record.subject.datasetId, recordId: record.id, contentId});
  return <section className="process-fact" data-record={record.id}>
    <div className="view-toolbar"><Tag>Commit {record.commitSequence}</Tag><FactSummary record={record}/></div><FactIdentity record={record}/>
    {relationCoverage && <div className="coverage-note">Relationships: {relationCoverage.observedOrdinals} / {relationCoverage.declared}; conflicts {relationCoverage.conflictingOrdinals}; unexpected {relationCoverage.unexpectedOrdinals}; inconsistent totals {relationCoverage.inconsistentTotals}</div>}
    {p.kind === "process_evidence" && p.judgment && entry.contents[p.judgment.detailsContentOrdinal] && <Button onClick={() => open(entry.contents[p.judgment!.detailsContentOrdinal]!.descriptor.id)}>Decision reasons / excluded options / unknowns</Button>}
    <div className="process-contents">{entry.contents.map(({descriptor, availability}) => <div key={descriptor.id}><Button onClick={() => open(descriptor.id)}>{descriptor.name}</Button><Tag>{availability}</Tag><span>{descriptor.stage} / {descriptor.retainedBytes} bytes</span></div>)}</div>
    {p.kind === "recording_link" && (p.target ? <Button onClick={() => onInclude(p.target!.sourceId, p.target!.datasetId, {sourceId: record.subject.sourceId, datasetId: record.subject.datasetId, recordId: record.id, linkId: null})}>Include linked recording</Button> : <Alert type="warning" title={p.limitation ?? "Recovery recording not identified"}/>)}
  </section>;
}
function RelationRows({relationships, onFocus, onContent, onInclude}: {relationships: readonly InspectionProcessRelation[]} & ProcessFocusProps) {
  return <div className="process-relations">{relationships.map(r => <section className="process-relation" key={`${r.observation.datasetId}:${r.link.id}`} id={`relation-${r.link.id}`}>
    <div className="view-toolbar"><Tag>{r.link.kind}</Tag><strong>{r.link.condition ?? "No explicit condition"}</strong><span>{r.link.operation}</span><span>#{r.observation.sequence} / ordinal {r.ordinal ?? "not applicable"}</span></div>
    {[{name: "From", endpoint: r.source, content: r.sourceContent}, {name: "To", endpoint: r.target, content: r.targetContent}].map(({name, endpoint, content}) => <div className="process-endpoint" key={name}>
      <span>{name}</span><Button type="link" className="fact-link" onClick={() => onFocus(endpoint.subject)}>{endpoint.subject.kind}: {endpoint.subject.id} / {endpoint.subject.revision ?? "unknown revision"}</Button><Tag>{endpoint.availability}</Tag>
      {endpoint.availability === "external" && <Button size="small" onClick={() => onInclude(endpoint.subject.sourceId, endpoint.subject.datasetId, {...r.observation, linkId: r.link.id})}>Include referenced recording</Button>}
      {content && <div className="process-location break-id">{content.location.stage} / part {content.location.partId ?? "unknown"} / {content.location.jsonPointer ?? "position unknown"} <Tag>{content.availability}</Tag>
        {content.recordId && content.location.contentId && <Button onClick={() => onContent({...content.recording, recordId: content.recordId!, contentId: content.location.contentId!, stage: content.location.stage, ...(content.location.jsonPointer === null ? {} : {jsonPointer: content.location.jsonPointer})})}>Open exact content location</Button>}</div>}
    </div>)}
  </section>)}{!relationships.length && <Empty description="No recorded relations in this page"/>}</div>;
}
