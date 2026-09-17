import { lazy, Suspense, useEffect, useState } from "react";
import { Alert, Button, Checkbox, Dropdown, Empty, Input, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import { ArrowLeftOutlined, ArrowRightOutlined, ReloadOutlined, SearchOutlined, SwapOutlined, CloseOutlined } from "@ant-design/icons";
import { inspectionSubjectKey, type InspectionRecord, type InspectionLink } from "@agent-anything/inspection/records";
import type { InspectionSelection } from "@agent-anything/inspection/query";
import { areas, areaViews, useInspectionSnapshot } from "./query-client/useInspectionSnapshot.js";
import { RecordDetails, payloadSummary } from "./records/RecordDetails.js";
import { ContentDrawer } from "./content/ContentDrawer.js";
import type { ContentTarget } from "./content/ContentLocation.js";
import { InspectionDetailDrawer } from "./records/InspectionDetailDrawer.js";
import { RunTree } from "./runs/RunTree.js";
import { RunOverview } from "./runs/RunOverview.js";
import { ObjectSummaries } from "./records/ObjectSummaries.js";
import { readContentTarget } from "./navigation/InspectionLocation.js";
import { inspectionObjectHistoryLocation, readInspectionDetailTarget, type InspectionDetailTarget } from "./navigation/InspectionDetailTarget.js";

import { CanvasFrame } from "./canvas/CanvasFrame.js";
const RelationGraph = lazy(async () => ({ default: (await import("./graph/RelationGraph.js")).RelationGraph }));
const DataFlowView = lazy(async () => ({ default: (await import("./data-flow/DataFlowView.js")).DataFlowView }));
const ExecutionTimeline = lazy(async () => ({ default: (await import("./timeline/ExecutionTimeline.js")).ExecutionTimeline }));
const ContentViewer = lazy(async () => ({ default: (await import("./content/ContentViewer.js")).ContentViewer }));
const LifecycleView = lazy(async () => ({ default: (await import("./runs/LifecycleView.js")).LifecycleView }));
const ExecutionFlowView = lazy(async () => ({ default: (await import("./execution-flow/ExecutionFlowView.js")).ExecutionFlowView }));
const label = (record: InspectionRecord) => record.payload.kind === "definition" ? record.payload.name : record.subject.id;

export function App() {
  const state = useInspectionSnapshot();
  const { params, setParams, sourceId, datasetId, area, view, runId, includeDescendants, selected, sources, datasets, datasetNext, loadDatasets, paging, bundle, loading, error, setError, navigate, choose, selectRun, showRecord, loadMore, refresh } = state;
  const [search, setSearch] = useState("");
  const [selectedLink, setSelectedLink] = useState<InspectionLink | null>(null);
  const content = readContentTarget(params.get("content"));
  const setContent = (value:ContentTarget|null) => navigate({content:value ? JSON.stringify(value):null});
  const detailTarget = readInspectionDetailTarget(params.get("detail"));
  const setDetailTarget = (target: InspectionDetailTarget | null) => navigate({ detail: target ? JSON.stringify(target) : null });
  const setFactId = (recordId: string) => setDetailTarget({ kind: "record", recordId });
  const openSubject = (subject: NonNullable<typeof selected>) => setDetailTarget({ kind: "object", subject });
  const openRelation = (link: InspectionLink) => setDetailTarget({ kind: "relation", recordId: link.establishedBy, linkId: link.id });
  const setContentId = (id: string | null) => setContent(id ? {id} : null);
  const openHistory = (subject: NonNullable<typeof selected>) => { navigate(inspectionObjectHistoryLocation(subject)); };
  const [comparison, setComparison] = useState<{ record: InspectionRecord; selection: InspectionSelection } | null>(null);
  const selectionKey = selected ? inspectionSubjectKey(selected) : "";
  useEffect(() => { setSelectedLink(null); }, [sourceId, datasetId, bundle?.snapshot.selection?.watermark]);
  useEffect(() => setSelectedLink(null), [view, area, selectionKey]);
  const inventory = bundle?.inventory.records.filter((record) => `${label(record)} ${record.subject.owner} ${record.subject.kind}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const records = bundle?.view.records ?? [];
  const detail = bundle?.selected ?? null;
  const graph = bundle?.view.graph;
  const coverage = bundle?.snapshot.coverage;
  const selectionRef = loading && detail ? detail.subject : selected;
  const selectionRecord = detail && selectionRef && inspectionSubjectKey(detail.subject) === inspectionSubjectKey(selectionRef) ? detail : null;
  const hasTree = area !== "Definitions";
  const sideDetail = view !== "Data Flow" && (area === "Definitions" || area === "Comparison" || view === "Records" || !!selectedLink);
  const availableViews = areaViews[area]!;
  const mainViews = area === "Runs" ? availableViews.slice(0,5) : availableViews;
  const visibleSelection = !selected || inventory.some((record) => inspectionSubjectKey(record.subject) === selectionKey);
  const recordColumns = [
    { title: "Seq", dataIndex: "commitSequence", width: 65 },
    { title: "Kind", render: (_value: unknown, record: InspectionRecord) => record.payload.kind, width: 100 },
    { title: "Object", render: (_value: unknown, record: InspectionRecord) => <span className="break-id">{label(record)}<small className="table-owner">{record.subject.owner}</small></span>, width: 190 },
    { title: "Recorded fact", render: (_value: unknown, record: InspectionRecord) => <span className="break-id">{payloadSummary(record.payload)}</span> },
    { title: "Observed", render: (_value: unknown, record: InspectionRecord) => record.occurredAt ? new Date(record.occurredAt).toLocaleTimeString() : "Not recorded", width: 110 },
  ];
  return <div className="inspector">
    <header className="app-header">
      <div className="app-title">Agent Inspector</div>
      <Select aria-label="Source" placeholder="Select source" value={sourceId || undefined} options={sources.map((source) => ({ value: source.sourceId, label: source.name }))} onChange={(value) => setParams({ source: value })} />
      <Select aria-label="Recording" placeholder="Select recording" value={datasetId || undefined} options={datasets.map((dataset) => ({ value: dataset.datasetId, label: `${new Date(dataset.createdAt).toLocaleString()} / ${dataset.status}` }))} onChange={(value) => setParams({ source: sourceId, dataset: value })} />
      <Tooltip title="Refresh recorded snapshot"><Button aria-label="Refresh" icon={<ReloadOutlined />} loading={loading} disabled={loading || paging} onClick={() => { void refresh(); }} /></Tooltip>
      {datasetNext && <Button size="small" loading={paging} onClick={() => { void loadDatasets(); }}>More recordings</Button>}
    </header>
    <div className="snapshot-bar"><Space>
      <Tooltip title="Back"><Button aria-label="Back" type="text" icon={<ArrowLeftOutlined />} onClick={() => history.back()} /></Tooltip>
      <Tooltip title="Forward"><Button aria-label="Forward" type="text" icon={<ArrowRightOutlined />} onClick={() => history.forward()} /></Tooltip>
    </Space>{coverage ? <><Tag>{coverage.status}</Tag><span>Snapshot {coverage.watermark}</span><span>{coverage.captured} records</span><span>Read {new Date(bundle!.snapshot.readAt).toLocaleTimeString()}</span>
      {coverage.dropped + coverage.rejected + coverage.telemetryDropped > 0 && <Tag color="warning">Partial capture</Tag>}{loading && <Tag>Reading next view; previous snapshot retained</Tag>}
    </> : <span>No recording selected</span>}</div>
    {error && <Alert className="query-alert" type="error" closable onClose={() => setError(null)} title={error} />}
    <nav className="area-tabs"><Tabs activeKey={area} onChange={(value) => navigate({ area: value })} items={areas.map((key) => ({ key, label: key }))} /></nav>
    {!datasetId ? <main className="empty-workspace"><Empty description={sources.length ? "Select a source and recording" : "No recorded sources"} /></main> : <main className={`workspace${!sideDetail ? " workspace-flow" : ""}`}>
      <aside className="object-pane">
        <Input aria-label="Search objects" prefix={<SearchOutlined />} placeholder="Search loaded objects" value={search} onChange={(event) => setSearch(event.target.value)} />
        {selected && selectionRef && <div className="object-selection" role="group" aria-label="Selected object">
          <div className="object-selection-label">Selected object{loading && <Spin size="small" />}</div>
          <div className="object-selection-value">
            <Typography.Text ellipsis={{ tooltip: `${selectionRef.kind}: ${selectionRef.id}` }}>{selectionRecord ? label(selectionRecord) : selectionRef.id}</Typography.Text>
            <Tooltip title="Clear object selection"><Button size="small" type="text" aria-label="Clear object selection" icon={<CloseOutlined />} onClick={() => navigate({ subject: null, record: null })} /></Tooltip>
          </div>
          <span className="object-selection-kind">{selectionRef.kind}</span>
        </div>}
        <div className="object-list">{hasTree ? <RunTree records={bundle?.inventory.records ?? []} selected={runId} search={search} onSelect={selectRun} /> : <>{inventory.map((record) => <button key={record.id} className={`object-row ${inspectionSubjectKey(record.subject) === selectionKey ? "selected" : ""}`} onClick={() => choose(record.subject)}>
          <span className="object-kind">{record.subject.kind}</span><strong title={label(record)}>{label(record)}</strong><small>{record.subject.owner}{record.payload.kind === "snapshot" ? ` / ${record.payload.status}` : ""}</small>
        </button>)}{inventory.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No objects in this scope" />}</>}</div>
        {bundle?.inventory.next !== null && bundle && <Button size="small" disabled={loading || paging} onClick={() => { void loadMore("inventory"); }}>Load more objects</Button>}
      </aside>
      <section className="investigation" data-view={bundle?.view.kind} data-watermark={bundle?.snapshot.selection?.watermark}>
        {!visibleSelection && !hasTree && !loading && <div className="coverage-note">Selected object is outside the loaded catalog or current filter.</div>}
        <Suspense fallback={<div className="view-loading"><Spin /></div>}>
          {area === "Comparison" ? <div className="comparison-view"><div className="view-toolbar">
            <Button icon={<SwapOutlined />} disabled={!detail || loading} onClick={() => { if (detail && bundle?.snapshot.selection) setComparison({ record: detail, selection: bundle.snapshot.selection }); }}>Pin selection</Button>
            <span>{comparison ? `Baseline: ${comparison.record.subject.id} @ ${comparison.selection.watermark}` : "No baseline selected"}</span>
          </div>{detail && comparison ? <ContentViewer text={JSON.stringify(detail, null, 2)} compare={JSON.stringify(comparison.record, null, 2)} language="json" /> : <Empty description="Pin a baseline, then select another object" />}</div> : <>
            <div className="investigation-scope">{hasTree && <><span title={runId}>{runId ? `Run ${runId.slice(0,16)}` : "All Runs"}</span>{runId && <Checkbox checked={includeDescendants} onChange={event=>navigate({descendants:event.target.checked?"true":null})}>Include descendants</Checkbox>}</>}</div>
            <Tabs className="view-tabs" activeKey={view} onChange={(value) => navigate({ view: value })} items={[...mainViews,...(mainViews.includes(view)?[]:[view])].map((key) => ({ key, label: key }))} tabBarExtraContent={area === "Runs" ? <Dropdown menu={{items:availableViews.slice(5).map(key=>({key,label:key})),onClick:({key})=>navigate({view:key})}}><Button type="text">More views</Button></Dropdown>:undefined} />
            <div className="view-content">{view === "Overview" ? <RunOverview summary={bundle?.inventory.summaries?.find(item=>item.subject.id===runId)} onRecord={setFactId} onContent={setContentId} onView={value=>navigate({view:value,subject:JSON.stringify(bundle?.inventory.records.find(record=>record.subject.id===runId)?.subject ?? selected)})}/>
              : view === "Requests" || view === "Calls" || view === "Scheduling" ? <ObjectSummaries kind={view} summaries={bundle?.view.summaries ?? []} onRecord={setFactId} onContent={setContentId} onHistory={openHistory}/>
              : view === "Execution Flow" ? bundle?.snapshot.selection && runId ? <ExecutionFlowView key={`${sourceId}:${datasetId}:${runId}`} scope={bundle.snapshot.selection} runId={runId} paused={loading} params={params} navigate={navigate} onContent={setContentId} onRecord={setFactId} onSubject={openHistory} /> : <Empty description="Select a Run to inspect its execution flow" />
              : view === "Data Flow" && graph ? <DataFlowView key={`${sourceId}:${datasetId}:${bundle?.snapshot.selection?.watermark}:${selectionKey}:${runId}:${includeDescendants}`} graph={graph} selected={selected?.kind === "run" && params.get("dataFocus") !== "true" ? null : selected} runId={runId} onFocus={subject=>navigate({subject:JSON.stringify(subject),record:null,dataFocus:"true"})} onReset={()=>navigate({subject:null,record:null,dataFocus:null})} onRecord={setFactId} onContent={setContent} />
              : graph ? graph.nodes.length ? <CanvasFrame title={view}><RelationGraph graph={graph} selected={selected} onSelect={choose} onLink={(id) => setSelectedLink(graph.links.find((link) => link.id === id) ?? null)} /></CanvasFrame> : <Empty description="No recorded relations in this scope" />
              : view === "Timeline" ? bundle?.view.intervals.length ? <CanvasFrame title="Timeline"><ExecutionTimeline scopeKey={[sourceId,datasetId,runId,includeDescendants].join(":")} intervals={bundle.view.intervals} runRecords={bundle.inventory.records} onRecord={setFactId} /></CanvasFrame> : <Empty description="No execution intervals recorded" />
              : view === "Lifecycle" ? selected ? <LifecycleView records={records} relatedRecords={bundle?.view.relatedRecords} onRecord={record=>setFactId(record.id)} /> : <Empty description="Select an object to inspect its lifecycle" />
              : view === "Telemetry" ? <ContentViewer text={JSON.stringify(bundle?.view.telemetry ?? [], null, 2)} language="json" />
              : <><Table className="records-table" size="small" rowKey="id" columns={recordColumns} dataSource={[...records]} pagination={{ pageSize: 25, showSizeChanger: false }} scroll={{ x: 650 }} rowClassName={(record) => record.id === params.get("record") ? "record-selected" : ""} onRow={(record) => ({ onClick: () => showRecord(record) })} />
                </>}
              {view !== "Execution Flow" && bundle?.view.next !== null && bundle && <Button disabled={loading || paging} onClick={() => { void loadMore("view"); }}>{view === "Timeline" ? "Load more intervals" : "Load more records"}</Button>}
            </div>
          </>}
        </Suspense>
        {bundle?.view.limitations.length ? <div className="coverage-note">{bundle.view.limitations.join(" / ")}</div> : null}
        {coverage?.limitations.length ? <div className="coverage-note">{coverage.limitations.join(" / ")}</div> : null}
      </section>
      {sideDetail && <aside className="detail-pane"><h2>{selectedLink ? "Recorded relation" : "Object detail"}</h2>
        <RecordDetails record={detail} link={selectedLink} onSubject={openSubject} onRecord={setFactId} onContent={setContentId} onLocation={setContent} onRelation={openRelation} />
      </aside>}
    </main>}
    <InspectionDetailDrawer target={detailTarget} scope={bundle?.snapshot.selection ?? null} onClose={() => setDetailTarget(null)} onTarget={setDetailTarget} onContent={setContent} onHistory={openHistory} />
    <ContentDrawer id={content?.id ?? null} location={content} scope={bundle?.snapshot.selection ?? null} onClose={() => setContent(null)} />
  </div>;
}
