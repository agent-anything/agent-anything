import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { InspectionRecord, InspectionSubjectRef } from "@agent-anything/inspection/records";
import type { InspectionReadResult, InspectionViewQuery } from "@agent-anything/inspection/query";
import { inspectionQuery, openInspectorSession } from "./InspectorClient.js";

export const areas = ["Definitions", "Runs", "Model Interaction", "Execution", "Comparison"];
export const views: Record<string, InspectionViewQuery> = { Records: "list_records", Hierarchy: "get_hierarchy", Lifecycle: "get_lifecycle", "Data Flow": "get_data_flow", Scheduling: "get_scheduling", Dependencies: "get_dependencies", Timeline: "get_timeline", Telemetry: "get_telemetry" };
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
  const view = Object.hasOwn(views, params.get("view") ?? "") ? params.get("view")! : "Records";
  let selected: InspectionSubjectRef | null = null;
  try { selected = JSON.parse(params.get("subject") ?? "null") as InspectionSubjectRef | null; } catch { /* Invalid URL selection is not a new object. */ }
  const key = params.toString();
  const inventoryFilter = { kind: (area === "Definitions" ? "list_definitions" : area === "Runs" ? "list_runs" : "list_records") as InspectionViewQuery, recordKind: area === "Model Interaction" ? "request" : area === "Execution" ? "execution" : undefined };

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
      const result = await inspectionQuery({ ...scope, kind: views[view]!, subject: view === "Timeline" ? undefined : selected ?? undefined, runId: view === "Timeline" ? selected?.runId ?? undefined : undefined, limit: 500 }, abort.signal);
      if (active !== generation.current) return;
      // Publish one coherent snapshot only after every active view succeeds.
      setBundle({ snapshot, inventory, view: result, selected: detail?.records[0] ?? null });
      const next = new URLSearchParams(params); next.set("watermark", String(scope.watermark));
      completedKey.current = next.toString();
      if (completedKey.current !== key) setParams(next, { replace: !refresh });
    } catch (failure) { if (active === generation.current && !abort.signal.aborted) setError((failure as Error).message); }
    finally { if (active === generation.current) setLoading(false); }
  }
  useEffect(() => {
    if (!datasetId) { generation.current++; pending.current?.abort(); setBundle(null); setLoading(false); completedKey.current = ""; return; }
    if (completedKey.current !== key) void load();
  }, [ready, key]);

  function navigate(values: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(values)) { if (value === null) next.delete(name); else next.set(name, value); }
    setParams(next);
  }
  function choose(subject: InspectionSubjectRef) { navigate({ subject: JSON.stringify(subject), record: null }); }
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
      const page = await inspectionQuery({ ...bundle.snapshot.selection, ...(target === "inventory" ? inventoryFilter : { kind: views[view]!, subject: view === "Timeline" ? undefined : selected ?? undefined, runId: view === "Timeline" ? selected?.runId ?? undefined : undefined }), after: Number(bundle[target].next), limit: 500 });
      if (active === generation.current) setBundle((current) => current ? { ...current, [target]: target === "view" && view === "Timeline" ? page : { ...page, records: [...new Map([...current[target].records, ...page.records].map((record) => [record.id, record])).values()], telemetry: [...current[target].telemetry, ...page.telemetry] } } : current);
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
  return { params, setParams, key, sourceId, datasetId, area, view, selected, sources, datasets, datasetNext, loadDatasets, paging, bundle, loading: reading, error, setError, navigate, choose, showRecord, findRecord, loadMore, refresh };
}
