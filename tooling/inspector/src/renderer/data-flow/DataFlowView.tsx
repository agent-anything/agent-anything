import { lazy, Suspense, useMemo, useState } from "react";
import { Button, Collapse, Descriptions, Drawer, Empty, Select, Space, Spin, Table, Tag, Tooltip } from "antd";
import { EyeOutlined, FileTextOutlined, RightOutlined, UndoOutlined } from "@ant-design/icons";
import { inspectionSubjectKey, type InspectionContentLocation, type InspectionLink, type InspectionSubjectRef } from "@agent-anything/inspection/records";
import type { InspectionGraph } from "@agent-anything/inspection/query";
import type { ContentTarget } from "../content/ContentLocation.js";
import { DataFlowGraph } from "./DataFlowGraph.js";
import { CanvasFrame } from "../canvas/CanvasFrame.js";
import { CanvasSplit } from "../canvas/CanvasSplit.js";
import { dataFlowNeighborhood, dataObjectTitle, dataRelationKinds, defaultDataFocus, shortDataIdentity, type DataFlowObject, type DataRelationFilter } from "./DataFlowModel.js";

const ContentViewer = lazy(async () => ({ default: (await import("../content/ContentViewer.js")).ContentViewer }));

function TransferLocation({ location, recordId, onContent }: { location: InspectionContentLocation | null; recordId: string; onContent: (target: ContentTarget) => void }) {
  if (!location) return <span className="data-unavailable">Location not recorded</span>;
  return <div className="data-transfer-location"><strong>{location.stage}</strong>
    {location.partId && <span>Part: {location.partId}</span>}
    {location.jsonPointer !== null && <code>{location.jsonPointer || "/ (document root)"}</code>}
    {location.contentId ? <Button type="link" icon={<FileTextOutlined />} onClick={() => onContent({ id: location.contentId!, jsonPointer: location.jsonPointer ?? undefined, stage: location.stage, recordId })}>Open recorded content</Button>
      : <span className="data-unavailable">Content reference not recorded</span>}
  </div>;
}

export function DataFlowView({ graph, selected, runId, onFocus, onReset, onRecord, onContent }: {
  graph: InspectionGraph; selected: InspectionSubjectRef | null; runId?: string;
  onFocus: (subject: InspectionSubjectRef) => void; onReset: () => void;
  onRecord: (id: string) => void; onContent: (target: ContentTarget) => void;
}) {
  const [filter, setFilter] = useState<DataRelationFilter>("all");
  const [relations, setRelations] = useState<InspectionLink[]>([]);
  const [relationIndex, setRelationIndex] = useState(0);
  const objects = useMemo(() => new Map(graph.nodes.map(node => [inspectionSubjectKey(node.subject), node])), [graph]);
  const focus = selected ? objects.get(inspectionSubjectKey(selected)) : undefined;
  const active = focus ?? defaultDataFocus(graph, runId);
  const neighborhood = useMemo(() => active ? dataFlowNeighborhood(graph, active.subject, filter) : null, [graph, active, filter]);
  const object = (subject: InspectionSubjectRef): DataFlowObject => objects.get(inspectionSubjectKey(subject)) ?? { subject, record: null, availability: "not_observed" };
  const openRelations = (links: InspectionLink[]) => { setRelations(links); setRelationIndex(0); };
  const follow = (subject: InspectionSubjectRef) => { setRelations([]); onFocus(subject); };
  const relation = relations[relationIndex];
  const options = useMemo(() => [...new Set(graph.nodes.map(node => node.subject.kind))].map(kind => ({ label: kind, options: graph.nodes.filter(node => node.subject.kind === kind).map(node => ({
    value: inspectionSubjectKey(node.subject), label: `${dataObjectTitle(node)} / ${shortDataIdentity(node.subject)}${node.subject.revision ? ` / rev ${node.subject.revision}` : ""}`,
    searchText: `${dataObjectTitle(node)} ${node.subject.id} ${node.subject.owner} ${node.subject.revision ?? ""}`,
  })) })), [graph]);
  if (!active || !neighborhood) return <Empty description="No recorded data relations in this scope" />;
  const activeKey = inspectionSubjectKey(active.subject);
  const relatedSubject = (link: InspectionLink) => inspectionSubjectKey(link.from) === activeKey ? link.to : link.from;
  return <div className="data-flow-view">
    <div className="data-focus-toolbar">
      <label className="data-focus-select"><span>Focus object</span><Select aria-label="Data flow focus" showSearch={{ filterOption: (input, option) => String(option && "searchText" in option ? option.searchText : "").toLowerCase().includes(input.toLowerCase()) }} value={activeKey} options={options} onChange={key => { const node = objects.get(key); if (node) follow(node.subject); }} /></label>
      <label className="data-kind-select"><span>Relation</span><Select aria-label="Data relation kind" value={filter} options={[{value:"all",label:"All relations"}, ...dataRelationKinds.map(kind => ({value:kind,label:kind}))]} onChange={value => { setFilter(value); setRelations([]); }} /></label>
      <Tooltip title="Return to Run data flow"><Button aria-label="Reset data flow focus" icon={<UndoOutlined />} disabled={!selected} onClick={onReset} /></Tooltip>
    </div>
    <div className="data-focus-summary"><div><strong>{dataObjectTitle(active)}</strong><span>{active.subject.kind} / {active.subject.owner}{active.subject.revision ? ` / rev ${active.subject.revision}` : ""}</span></div>
      <Tooltip title={active.subject.id}><code>{shortDataIdentity(active.subject)}</code></Tooltip>
      {active.record && <Button type="link" size="small" icon={<FileTextOutlined />} onClick={() => onRecord(active.record!.id)}>Latest object record</Button>}
    </div>
    <CanvasSplit view="data-flow" canvas={<CanvasFrame title="Data Flow"><DataFlowGraph key={`${activeKey}:${filter}`} focus={active} incoming={neighborhood.incoming} outgoing={neighborhood.outgoing} onFocus={follow} onRelations={openRelations} /></CanvasFrame>} details={<>
    <div className="data-relations-heading"><h3>Recorded relations <span>{neighborhood.links.length}</span></h3>
      <span>{graph.scope === "selected_neighborhood" ? "Object neighborhood" : `${graph.nodes.length} loaded objects`}{graph.limited ? " / Query limit reached" : ""}</span>
    </div>
    <Table key={`${activeKey}:${filter}`} className="data-relations-table" size="small" rowKey="id" dataSource={neighborhood.links} pagination={{pageSize:8,showSizeChanger:false,hideOnSinglePage:true}} scroll={{x:760}} onRow={link => ({onClick:()=>openRelations([link])})} columns={[
      {title:"Direction",width:95,render:(_value,link)=>inspectionSubjectKey(link.from)===activeKey && inspectionSubjectKey(link.to)===activeKey ? "Self" : inspectionSubjectKey(link.to)===activeKey ? "Incoming" : "Outgoing"},
      {title:"Object",width:220,render:(_value,link)=><div className="data-table-object"><strong>{dataObjectTitle(object(relatedSubject(link)))}</strong><small title={relatedSubject(link).id}>{relatedSubject(link).kind} / {shortDataIdentity(relatedSubject(link))}</small></div>},
      {title:"Relation",width:110,render:(_value,link)=><Tag color={link.kind==="omits"?"warning":undefined}>{link.kind}</Tag>},
      {title:"Operation / recorded stages",render:(_value,link)=><div className="data-table-object"><span>{link.operation ?? "Not recorded"}</span><small>{link.sourceLocation?.stage ?? "Unknown source"} <RightOutlined /> {link.targetLocation?.stage ?? "Unknown target"}</small></div>},
      {title:"",width:45,render:(_value,link)=><Tooltip title="Inspect relation"><Button type="text" aria-label="Inspect relation" icon={<EyeOutlined />} onClick={event=>{event.stopPropagation();openRelations([link]);}} /></Tooltip>},
    ]} />
    {graph.limited && <div className="coverage-note">The query is partial. Following an object reads its own neighborhood at this snapshot.</div>}
    </>} />
    <Drawer title="Recorded relation" open={!!relation} onClose={()=>setRelations([])} size={560}>
      {relation && <>
        {relations.length > 1 && <Select className="data-relation-picker" aria-label="Recorded link" value={relationIndex} options={relations.map((link,index)=>({value:index,label:`${index+1}. ${link.kind} / ${link.operation ?? "No operation recorded"}`}))} onChange={setRelationIndex} />}
        <Space><Tag color={relation.kind==="omits"?"warning":"blue"}>{relation.kind}</Tag><span>{relation.operation ?? "Operation not recorded"}</span></Space>
        {(["from","to"] as const).map(endpoint => <section key={endpoint} className="data-endpoint">
          <h3>{endpoint === "from" ? "Source" : "Target"}</h3><strong>{dataObjectTitle(object(relation[endpoint]))}</strong>
          <span>{relation[endpoint].kind} / {relation[endpoint].owner}{relation[endpoint].revision ? ` / rev ${relation[endpoint].revision}` : ""}</span>
          <code>{relation[endpoint].id}</code>
          <Button type="link" icon={<RightOutlined />} onClick={()=>follow(relation[endpoint])}>Trace this object</Button>
          <TransferLocation location={endpoint === "from" ? relation.sourceLocation : relation.targetLocation} recordId={relation.establishedBy} onContent={onContent} />
        </section>)}
        <Descriptions column={1} size="small" items={[
          {key:"condition",label:"Condition",children:relation.condition ?? "Not applicable"},
          {key:"record",label:"Evidence",children:<Button type="link" aria-label="Open establishing record" icon={<FileTextOutlined />} onClick={()=>onRecord(relation.establishedBy)}>Open establishing record</Button>},
        ]} />
        <Collapse items={[{key:"raw",label:"Raw relation",children:<Suspense fallback={<Spin />}><ContentViewer text={JSON.stringify(relation,null,2)} language="json" /></Suspense>}]} />
      </>}
    </Drawer>
  </div>;
}
