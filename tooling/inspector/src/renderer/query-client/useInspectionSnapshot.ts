import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { InspectionRecord, InspectionSubjectRef } from "@agent-anything/inspection/records";
import type { InspectionReadResult, InspectionViewQuery } from "@agent-anything/inspection/query";
import { inspectionQuery, openInspectorSession } from "./InspectorClient.js";
import { inspectionReadLocation } from "../navigation/InspectionLocation.js";

export const areas = ["Definitions", "Runs", "Model Interaction", "Execution", "Comparison"];
export const views: Record<string, InspectionViewQuery | "get_execution_flow"> = { Overview: "list_runs", Requests: "get_model_request", Calls: "get_execution", Records: "list_records", "Execution Flow": "get_execution_flow", Hierarchy: "get_hierarchy", Lifecycle: "get_lifecycle", "Data Flow": "get_data_flow", Scheduling: "get_scheduling", Dependencies: "get_dependencies", Timeline: "get_timeline", Telemetry: "get_telemetry" };
export const areaViews: Record<string, string[]> = {
  Definitions: ["Records", "Data Flow", "Dependencies"],
  Runs: ["Overview", "Execution Flow", "Lifecycle", "Timeline", "Data Flow", "Hierarchy", "Scheduling", "Dependencies", "Records", "Telemetry"],
  "Model Interaction": ["Requests", "Data Flow", "Records", "Telemetry"],
  Execution: ["Calls", "Scheduling", "Timeline", "Dependencies", "Data Flow", "Records"],
  Comparison: ["Records"],
};
export interface InspectionBundle {
  snapshot: InspectionReadResult;
  inventory: InspectionReadResult;
  view: InspectionReadResult;
  selected: InspectionRecord | null;
}

export function useInspectionSnapshot() {
  const [params, setParams] = useSearchParams();
  const [ready, setReady] = useState(false);
  const [sources, setSources] = useState<InspectionReadResult["sources"]>([]);
  const [datasets, setDatasets] = useState<InspectionReadResult["datasets"]>([]);
  const [datasetNext, setDatasetNext] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  const pagePending = useRef(false);
  const sourceGeneration = useRef(0);
  const [bundle, setBundle] = useState<InspectionBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const completedKey = useRef("");
  const sourceId = params.get("source") ?? "";
  const datasetId = params.get("dataset") ?? "";
  const area = areas.includes(params.get("area") ?? "") ? params.get("area")! : "Runs";
  const view = areaViews[area]!.includes(params.get("view") ?? "") ? params.get("view")! : areaViews[area]![0]!;
  let selected: InspectionSubjectRef | null = null;
  try { selected = JSON.parse(params.get("subject") ?? "null") as InspectionSubjectRef | null; } catch { /* Invalid URL selection is not a new object. */ }
  const runId = params.get("run") ?? (selected?.kind === "run" ? selected.id : selected?.runId) ?? undefined;
  const includeDescendants = params.get("descendants") === "true";
  const key = inspectionReadLocation(params);
  const inventoryFilter = {kind: (area === "Definitions" ? "list_definitions" : "list_runs") as InspectionViewQuery};
  const dataObjectFocus = view === "Data Flow" && selected !== null && (selected.kind !== "run" || params.get("dataFocus") === "true");
  const viewFilter = () => ({
    kind: views[view] as InspectionViewQuery,
    subject: ["Requests", "Calls", "Scheduling", "Timeline", "Overview", "Execution Flow"].includes(view) || (view === "Data Flow" && !dataObjectFocus) ? undefined : selected ?? undefined,
    ...(runId && area !== "Definitions" && !dataObjectFocus ? {runId, includeDescendants} : {}),
  });

  useEffect(() => {
    let disposed = false;
    void openInspectorSession().then(() => inspectionQuery({ kind: "list_sources" })).then((result) => {
      if (!disposed) { setSources(result.sources); setReady(true); }
    }).catch((failure: Error) => { if (!disposed) setError(failure.message); });
    return () => { disposed = true; pending.current?.abort(); };
  }, []);
  useEffect(() => {
    sourceGeneration.current++;
    setDatasets([]); setDatasetNext(null);
    if (!ready || !sourceId) return;
    let disposed = false;
    void inspectionQuery({ kind: "list_datasets", sourceId }).then((result) => { if (!disposed) { setDatasets(result.datasets); setDatasetNext(result.next as string | null); } }).catch((failure: Error) => { if (!disposed) setError(failure.message); });
    return () => { disposed = true; };
  }, [ready, sourceId]);

  async function load(refresh = false) {
    if (!ready || !sourceId || !datasetId) return;
    const active = ++generation.current;
    pending.current?.abort(); const abort = new AbortController(); pending.current = abort;
    setLoading(true); setError(null);
    try {
      const watermark = refresh || !params.has("watermark") ? undefined : Number(params.get("watermark"));
      const snapshot = await inspectionQuery({ kind: "get_snapshot", sourceId, datasetId, watermark }, abort.signal);
      const scope = snapshot.selection!;
      const inventory = await inspectionQuery({ ...scope, ...inventoryFilter, limit: 100 }, abort.signal);
      const recordId = params.get("record");
      const detail = recordId ? await inspectionQuery({ ...scope, kind: "get_record", recordId }, abort.signal)
        : selected ? await inspectionQuery({ ...scope, kind: "get_subject", subject: selected }, abort.signal) : null;
      const result = await inspectionQuery(view === "Execution Flow"
        ? runId ? { ...scope, kind: "get_execution_flow", runId, limit: 100 } : { ...scope, kind: "list_records", limit: 1 }
        : { ...scope, ...viewFilter(), limit: view === "Requests" || view === "Calls" || view === "Scheduling" ? 50 : 100 }, abort.signal);
      if (active !== generation.current) return;
      // Publish one coherent snapshot only after every active view succeeds.
      setBundle({ snapshot, inventory, view: result, selected: detail?.records[0] ?? null });
      const next = new URLSearchParams(params); next.set("watermark", String(scope.watermark));
      completedKey.current = inspectionReadLocation(next);
      if (completedKey.current !== key) setParams(current=>{const updated=new URLSearchParams(current);updated.set("watermark",String(scope.watermark));return updated;}, { replace: !refresh });
    } catch (failure) { if (active === generation.current && !abort.signal.aborted) setError((failure as Error).message); }
    finally { if (active === generation.current) setLoading(false); }
  }
  useEffect(() => {
    if (!datasetId) { generation.current++; pending.current?.abort(); setBundle(null); setLoading(false); completedKey.current = ""; return; }
    if (completedKey.current !== key) void load();
  }, [ready, key]);

  function navigate(values: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    if (values.area && values.area !== area) {
      next.delete("view"); next.delete("record");
      if (values.area === "Definitions") next.delete("subject");
      next.delete("fact"); next.delete("content");
    }
    for (const [name, value] of Object.entries(values)) { if (value === null) next.delete(name); else next.set(name, value); }
    setParams(next);
  }
  function choose(subject: InspectionSubjectRef) {
    navigate({subject: JSON.stringify(subject), record: null});
  }
  function selectRun(subject: InspectionSubjectRef) {
    navigate({run: subject.id, subject: JSON.stringify(subject), record: null, fact:null, content:null, flowRun:null, flowInvocation:null, flowOccurrence:null, flowStep:null, dataFocus:null});
  }
  function showRecord(record: InspectionRecord) { navigate({ subject: JSON.stringify(record.subject), record: record.id }); }
  async function findRecord(recordId: string) {
    if (!bundle?.snapshot.selection) return;
    const active = generation.current;
    try {
      const result = await inspectionQuery({ ...bundle.snapshot.selection, kind: "get_record", recordId });
      if (active !== generation.current) return;
      if (result.records[0]) showRecord(result.records[0]); else setError("The establishing record is not available at this snapshot.");
    } catch (failure) { if (active === generation.current) setError((failure as Error).message); }
  }
  async function loadMore(target: "inventory" | "view") {
    if (!bundle?.snapshot.selection || bundle[target].next === null || pagePending.current) return;
    pagePending.current = true; setPaging(true);
    const active = generation.current;
    try {
      const page = await inspectionQuery({ ...bundle.snapshot.selection, ...(target === "inventory" ? inventoryFilter : viewFilter()), after: String(bundle[target].next), limit: 500 });
      if (active === generation.current) setBundle((current) => current ? { ...current, [target]: { ...page, records: [...new Map([...current[target].records, ...page.records].map((record) => [record.id, record])).values()], telemetry: [...current[target].telemetry, ...page.telemetry], intervals: [...current[target].intervals, ...page.intervals], summaries: [...current[target].summaries ?? [], ...page.summaries ?? []] } } : current);
    } catch (failure) { if (active === generation.current) setError((failure as Error).message); }
    finally { pagePending.current = false; setPaging(false); }
  }
  async function loadDatasets(append = true) {
    if (!sourceId || (append && !datasetNext) || pagePending.current) return;
    const active = sourceGeneration.current; pagePending.current = true; setPaging(true);
    try {
      const result = await inspectionQuery({ kind: "list_datasets", sourceId, ...(append ? { after: datasetNext! } : {}) });
      if (active === sourceGeneration.current) { setDatasets((current) => append ? [...current, ...result.datasets] : result.datasets); setDatasetNext(result.next as string | null); }
    } catch (failure) { if (active === sourceGeneration.current) setError((failure as Error).message); }
    finally { pagePending.current = false; setPaging(false); }
  }
  async function refresh() {
    if (datasetId) { await load(true); await loadDatasets(false); return; }
    if (sourceId) { await loadDatasets(false); return; }
    try { const result = await inspectionQuery({ kind: "list_sources" }); setSources(result.sources); }
    catch (failure) { setError((failure as Error).message); }
  }
  const reading = loading || (ready && !!datasetId && completedKey.current !== key && error === null);
  return { params, setParams, key, sourceId, datasetId, area, view, runId, includeDescendants, selected, sources, datasets, datasetNext, loadDatasets, paging, bundle, loading: reading, error, setError, navigate, choose, selectRun, showRecord, findRecord, loadMore, refresh };
}
