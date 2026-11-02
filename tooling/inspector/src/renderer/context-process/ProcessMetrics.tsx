import {useEffect, useRef, useState} from "react";
import {Alert, Button, Empty, Select, Spin, Table, Tag} from "antd";
import {Timeline, type DataItem} from "vis-timeline/standalone";
import {DataSet} from "vis-data";
import type {InspectionMetricRead, InspectionMetricScope, InspectionMetricInterval} from "@agent-anything/inspection/query";
import {inspectionQuery} from "../query-client/InspectorClient.js";
import {CanvasFrame} from "../canvas/CanvasFrame.js";
import "vis-timeline/styles/vis-timeline-graph2d.min.css";

export function ProcessMetrics({scope, params, navigate, onRecord}: {scope: InspectionMetricScope; params: URLSearchParams;
  navigate(values: Record<string, string | null>): void;
  onRecord(location: {sourceId: string; datasetId: string; recordId: string}): void;
}) {
  const cursor = params.get("cpMetric") ?? undefined, section = params.get("cpMetricSection") === "intervals" ? "intervals" : "metrics", after = params.get("cpMetricPage") ?? undefined;
  const key = JSON.stringify([scope, cursor, section, after]);
  const [state, setState] = useState<{key: string; value: InspectionMetricRead | null}>({key, value: null});
  const result = state.key === key ? state.value : null;
  const setResult = (value: InspectionMetricRead | null) => setState({key, value});
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [drill, setDrill] = useState<InspectionMetricRead | null>(null), [memberId, setMemberId] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null), drillAbort = useRef<AbortController | null>(null), generation = useRef(0);
  useEffect(() => {
    const active = ++generation.current; const pending = new AbortController(); abort.current?.abort(); abort.current = pending;
    drillAbort.current?.abort(); setDrill(null); setMemberId(null); setResult(null); setError(null); setBusy(false);
    if (cursor) {setBusy(true); void inspectionQuery({...scope, kind: "read_process_metrics", cursor, section, after, limit: 30}, pending.signal).then(next => {
      if (active === generation.current) setResult(next.measurement ?? null);
    }).catch(e => {if (!pending.signal.aborted) setError(e.message);}).finally(() => {if (active === generation.current) setBusy(false);});}
    return () => {generation.current++; pending.abort(); drillAbort.current?.abort();};
  }, [key]);
  async function calculate() {
    abort.current?.abort(); const pending = new AbortController(); abort.current = pending; const active = ++generation.current;
    setBusy(true); setError(null); let current = cursor;
    try {
      // Each server advance is bounded; a UI action also has a finite work allowance.
      for (let i = 0; i < 20; i++) {
        const next = (await inspectionQuery({...scope, kind: "advance_process_metrics", cursor: current, limit: 100}, pending.signal)).measurement!;
        if (active !== generation.current) return;
        current = next.cursor; setResult(next);
        if (["complete", "limited", "released"].includes(next.status)) break;
      }
      if (active === generation.current) navigate({cpMetric: current ?? null, cpMetricPage: null});
    } catch (e) {if (!pending.signal.aborted) setError((e as Error).message);}
    finally {if (active === generation.current) {setBusy(false); if (current && current !== cursor) navigate({cpMetric: current});}}
  }
  async function readDrill(metricId: string | null, identity?: string, next?: string) {
    if (!cursor) return;
    drillAbort.current?.abort(); const pending = new AbortController(); drillAbort.current = pending; setError(null);
    try {
      const result = await inspectionQuery({...scope, kind: "read_process_metrics", cursor, section: identity ? "evidence" : "members", ...(identity ? {identity} : {metricId: metricId!}), after: next, limit: 30}, pending.signal);
      if (!pending.signal.aborted) {setDrill(result.measurement!); setMemberId(identity ?? metricId);}
    } catch (e) {if (!pending.signal.aborted) setError((e as Error).message);}
  }
  async function release() {
    abort.current?.abort(); generation.current++; setBusy(false);
    if (cursor) try {await inspectionQuery({...scope, kind: "release_process_metrics", cursor});} catch (e) {setError((e as Error).message);}
    navigate({cpMetric: null, cpMetricPage: null}); setResult(null); setDrill(null);
  }
  return <div className="process-metrics" data-status={result?.status ?? "not-started"} data-busy={busy}>
    <div className="coverage-note">Fixed Run-set totals. Fact-list purpose, recipient and commit filters do not reduce this cost scope.</div>
    <div className="view-toolbar"><Button disabled={busy || result?.status === "complete" || result?.status === "limited"} onClick={() => void calculate()}>{cursor ? "Continue bounded calculation" : "Calculate fixed scope"}</Button>
      {busy && <Button onClick={() => {generation.current++; abort.current?.abort(); setBusy(false); if (result?.cursor) navigate({cpMetric: result.cursor});}}>Cancel reading</Button>}
      {cursor && <Button onClick={() => void release()}>Release calculation</Button>}
      <Select aria-label="Metric view" value={section} options={[{value: "metrics", label: "Measurements"}, {value: "intervals", label: "Recorded intervals"}]} onChange={value => navigate({cpMetricSection: value, cpMetricPage: null})}/>
    </div>
    {error && <Alert type="error" title={error}/>}
    {busy && !result && <Spin/>}
    {result && <><div className="view-toolbar"><Tag>{result.status}</Tag><span>{result.scanned} observations / {result.identities} original identities</span><span>Calculation v{result.calculationVersion}</span><span>Expires {result.expiresAt}</span></div>
      {result.recordings.map(r => <div className="coverage-note break-id" key={r.selection.datasetId}>{r.selection.datasetId}: {r.availability} / index {r.index} / boundary {r.selection.watermark}</div>)}
      {!!result.limitations.length && <Alert type="warning" title={result.limitations.join("; ")}/>}
      {!["complete","limited","released"].includes(result.status) && <Alert type="info" title={`Calculation is ${result.status}; values are not final. Continue to the next bounded calculation when reading pauses.`}/>}
      {section === "metrics" ? <Table size="small" className="process-metric-table" rowKey="id" pagination={false} scroll={{x: 900}} dataSource={[...result.metrics]} columns={[
        {title: "Metric / unit", render: (_, m) => <Button type="link" className="fact-link" onClick={() => void readDrill(m.id)}>{m.metric} / {m.unit}</Button>},
        {title: "Purpose / dimensions", render: (_, m) => <span className="break-id">{Object.entries(m.dimensions).map(([k,v]) => `${k}: ${v ?? "unknown"}`).join("; ")}</span>},
        {title: "Evidence", dataIndex: "evidence", width: 100},
        {title: "Value", render: (_, m) => m.operation === "range" ? `${m.minimum ?? "unknown"} .. ${m.maximum ?? "unknown"}` : m.value ?? `Unknown (known subtotal ${m.knownValue ?? "unknown"})`},
        {title: "Observed / missing / conflicts", render: (_, m) => `${m.observed} / ${m.missing} / ${m.conflicts}`},
      ]}/> : <>{result.intervals.length ? <CanvasFrame title="Process intervals"><MetricTimeline intervals={result.intervals} onIdentity={identity => void readDrill(null, identity)}/></CanvasFrame> : <Empty description="No recorded closed intervals on this page"/>}
        <Table rowKey="identity" size="small" pagination={false} scroll={{x: 700}} dataSource={[...result.intervals]} columns={[
          {title: "Phase", render: (_, r) => <Button type="link" onClick={() => void readDrill(null, r.identity)}>{r.phase}</Button>},
          {title: "Run / clock", render: (_, r) => <span className="break-id">{r.runId} / {r.clock}</span>}, {title: "Category", dataIndex: "category"}, {title: "ms", dataIndex: "durationMs"},
        ]}/></>}
      {result.next && <Button onClick={() => navigate({cpMetricPage: result.next})}>Next measurement page</Button>}
      <details><summary>Query overhead (not task execution)</summary><dl>{Object.entries(result.overhead).map(([k,v]) => <div key={k}>{k}: {v.toFixed(2)} ms</div>)}</dl></details>
    </>}
    {drill && <section className="process-metric-evidence"><h3>Calculation evidence</h3>{drill.members.map(m => <div key={m.identity}><Button type="link" className="fact-link" onClick={() => void readDrill(null, m.identity)}>{m.identity}</Button></div>)}
      {drill.evidence.map(e => <div key={e.ordinal}><Button type="link" className="fact-link" onClick={() => onRecord(e.location)}>Original observation #{e.location.sequence} / {e.location.datasetId}</Button><Tag>{e.part}</Tag></div>)}
      {drill.next && <Button onClick={() => void readDrill(drill.members.length ? memberId : null, drill.evidence.length ? memberId! : undefined, drill.next!)}>Next calculation evidence page</Button>}
    </section>}
  </div>;
}
function MetricTimeline({intervals, onIdentity}: {intervals: readonly InspectionMetricInterval[]; onIdentity: (identity: string) => void}) {
  const host = useRef<HTMLDivElement>(null), selection = useRef(onIdentity); selection.current = onIdentity;
  const clocks = [...new Set(intervals.map(i => i.clock))];
  const [selected, setSelected] = useState<string | null>(null), clock = selected && clocks.includes(selected) ? selected : clocks[0];
  useEffect(() => {
    if (!host.current) return;
    const current = intervals.filter(i => i.clock === clock), names = [...new Set(current.map(i => `${i.runId ?? "unknown"} / ${i.category}`))];
    const items = new DataSet<DataItem>(current.map(i => ({id: i.identity, group: names.indexOf(`${i.runId ?? "unknown"} / ${i.category}`), content: `${i.phase} / ${i.durationMs.toFixed(2)} ms`, start: new Date(i.start), end: new Date(i.end)})));
    const text = (i: {content?: string} | null) => {const el = document.createElement("span"); el.textContent = i?.content ?? ""; return el;};
    const timeline = new Timeline(host.current, items, names.map((content, id) => ({id, content})), {height: "100%", autoResize: false, editable: false, showCurrentTime: false, stack: true, verticalScroll: true, template: text, groupTemplate: text,
      format: {minorLabels: {millisecond: "x", second: "x", minute: "x", hour: "x", weekday: "x", day: "x", week: "x", month: "x", year: "x"}, majorLabels: {millisecond: "[Monotonic ms]", second: "[Monotonic ms]", minute: "[Monotonic ms]", hour: "[Monotonic ms]", weekday: "[Monotonic ms]", day: "[Monotonic ms]", week: "[Monotonic ms]", month: "[Monotonic ms]", year: "[Monotonic ms]"}}});
    timeline.on("select", e => {if (e.items[0]) selection.current(String(e.items[0]));});
    let frame = 0; const resize = new ResizeObserver(() => {cancelAnimationFrame(frame); frame = requestAnimationFrame(() => timeline.redraw());}); resize.observe(host.current);
    return () => {resize.disconnect(); cancelAnimationFrame(frame); timeline.destroy(); items.clear();};
  }, [intervals, clock]);
  return <div className="process-timeline"><Select aria-label="Process interval clock" value={clock} options={clocks.map(value => ({value, label: value}))} onChange={setSelected}/><div ref={host} className="process-timeline-surface"/><div className="coverage-note">Closed intervals from this page only; one original monotonic clock. No inferred critical path or cross-process duration.</div></div>;
}
