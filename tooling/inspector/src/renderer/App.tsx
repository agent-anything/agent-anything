import { lazy, Suspense, useEffect, useState } from "react";
import { Alert, Button, Empty, Input, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import { ArrowLeftOutlined, ArrowRightOutlined, ReloadOutlined, SearchOutlined, SwapOutlined, CloseOutlined } from "@ant-design/icons";
import { inspectionSubjectKey, type InspectionRecord, type InspectionLink } from "@agent-anything/inspection/records";
import type { InspectionSelection } from "@agent-anything/inspection/query";
import { areas, views, useInspectionSnapshot } from "./query-client/useInspectionSnapshot.js";
import { RecordDetails, payloadSummary } from "./records/RecordDetails.js";
import { ContentDrawer } from "./content/ContentDrawer.js";

const RelationGraph = lazy(async () => ({ default: (await import("./graph/RelationGraph.js")).RelationGraph }));
const ExecutionTimeline = lazy(async () => ({ default: (await import("./timeline/ExecutionTimeline.js")).ExecutionTimeline }));
const ContentViewer = lazy(async () => ({ default: (await import("./content/ContentViewer.js")).ContentViewer }));
const LifecycleView = lazy(async () => ({ default: (await import("./runs/LifecycleView.js")).LifecycleView }));
const label = (record: InspectionRecord) => record.payload.kind === "definition" ? record.payload.name : record.subject.id;

export function App() {
  const state = useInspectionSnapshot();
  const { params, setParams, sourceId, datasetId, area, view, selected, sources, datasets, datasetNext, loadDatasets, paging, bundle, loading, error, setError, navigate, choose, showRecord, findRecord, loadMore, refresh } = state;
  const [search, setSearch] = useState("");
  const [selectedLink, setSelectedLink] = useState<InspectionLink | null>(null);
  const [contentId, setContentId] = useState<string | null>(null);
  const [comparison, setComparison] = useState<{ record: InspectionRecord; selection: InspectionSelection } | null>(null);
  const selectionKey = selected ? inspectionSubjectKey(selected) : "";
  useEffect(() => { setSelectedLink(null); setContentId(null); }, [bundle]);
  const inventory = bundle?.inventory.records.filter((record) => `${label(record)} ${record.subject.owner} ${record.subject.kind}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const records = bundle?.view.records ?? [];
  const detail = bundle?.selected ?? null;
  const graph = bundle?.view.graph;
  const coverage = bundle?.snapshot.coverage;
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
    {!datasetId ? <main className="empty-workspace"><Empty description={sources.length ? "Select a source and recording" : "No recorded sources"} /></main> : <main className="workspace">
      <aside className="object-pane">
        <Input aria-label="Search objects" prefix={<SearchOutlined />} placeholder="Search loaded objects" value={search} onChange={(event) => setSearch(event.target.value)} />
        <div className="object-list">{inventory.map((record) => <button key={record.id} className={`object-row ${inspectionSubjectKey(record.subject) === selectionKey ? "selected" : ""}`} onClick={() => choose(record.subject)}>
          <span className="object-kind">{record.subject.kind}</span><strong title={label(record)}>{label(record)}</strong><small>{record.subject.owner}{record.payload.kind === "snapshot" ? ` / ${record.payload.status}` : ""}</small>
        </button>)}{inventory.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No objects in this scope" />}</div>
        {bundle?.inventory.next !== null && bundle && <Button size="small" disabled={loading || paging} onClick={() => { void loadMore("inventory"); }}>Load more objects</Button>}
      </aside>
      <section className="investigation" data-view={bundle?.view.kind} data-watermark={bundle?.snapshot.selection?.watermark}>
        <div className="selection-heading"><Typography.Text strong ellipsis={{ tooltip: detail?.subject.id ?? selected?.id }}>{loading && detail ? `${detail.subject.kind}: ${detail.subject.id}` : selected ? `${selected.kind}: ${selected.id}` : "Recording overview"}</Typography.Text>{loading && <Spin size="small" />}
          {selected && <Tooltip title="Clear object selection"><Button size="small" type="text" aria-label="Clear object selection" icon={<CloseOutlined />} onClick={() => navigate({ subject: null, record: null })} /></Tooltip>}
        </div>
        {!visibleSelection && !loading && <div className="coverage-note">Selected object is outside the loaded catalog or current filter.</div>}
        <Suspense fallback={<div className="view-loading"><Spin /></div>}>
          {area === "Comparison" ? <div className="comparison-view"><div className="view-toolbar">
            <Button icon={<SwapOutlined />} disabled={!detail || loading} onClick={() => { if (detail && bundle?.snapshot.selection) setComparison({ record: detail, selection: bundle.snapshot.selection }); }}>Pin selection</Button>
            <span>{comparison ? `Baseline: ${comparison.record.subject.id} @ ${comparison.selection.watermark}` : "No baseline selected"}</span>
          </div>{detail && comparison ? <ContentViewer text={JSON.stringify(detail, null, 2)} compare={JSON.stringify(comparison.record, null, 2)} language="json" /> : <Empty description="Pin a baseline, then select another object" />}</div> : <>
            <Tabs className="view-tabs" activeKey={view} onChange={(value) => navigate({ view: value })} items={Object.keys(views).map((key) => ({ key, label: key }))} />
            <div className="view-content">{graph ? graph.nodes.length ? <RelationGraph graph={graph} selected={selected} onSelect={choose} onLink={(id) => setSelectedLink(graph.links.find((link) => link.id === id) ?? null)} /> : <Empty description="No recorded relations in this scope" />
              : view === "Timeline" ? bundle?.view.intervals.length ? <ExecutionTimeline intervals={bundle.view.intervals} onSelect={choose} /> : <Empty description="No execution intervals recorded" />
              : view === "Lifecycle" ? selected ? <LifecycleView records={records} onRecord={showRecord} /> : <Empty description="Select an object to inspect its lifecycle" />
              : view === "Telemetry" ? <ContentViewer text={JSON.stringify(bundle?.view.telemetry ?? [], null, 2)} language="json" />
              : <><Table className="records-table" size="small" rowKey="id" columns={recordColumns} dataSource={[...records]} pagination={{ pageSize: 25, showSizeChanger: false }} scroll={{ x: 650 }} rowClassName={(record) => record.id === params.get("record") ? "record-selected" : ""} onRow={(record) => ({ onClick: () => showRecord(record) })} />
                </>}
              {bundle?.view.next !== null && bundle && <Button disabled={loading || paging} onClick={() => { void loadMore("view"); }}>{view === "Timeline" ? "Next interval page" : "Load more records"}</Button>}
            </div>
          </>}
        </Suspense>
        {bundle?.view.limitations.length ? <div className="coverage-note">{bundle.view.limitations.join(" / ")}</div> : null}
        {coverage?.limitations.length ? <div className="coverage-note">{coverage.limitations.join(" / ")}</div> : null}
      </section>
      <aside className="detail-pane"><h2>{selectedLink ? "Recorded relation" : "Object detail"}</h2>
        <RecordDetails record={detail} link={selectedLink} onSubject={choose} onRecord={(id) => { void findRecord(id); }} onContent={setContentId} />
      </aside>
    </main>}
    <ContentDrawer id={contentId} scope={bundle?.snapshot.selection ?? null} onClose={() => setContentId(null)} />
  </div>;
}
