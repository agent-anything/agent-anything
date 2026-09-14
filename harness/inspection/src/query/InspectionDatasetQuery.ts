import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { containedInspectionPath, datasetDirectory, validateOpaqueId, type InspectionSource, type InspectionDatasetManifest } from "../sources/index.js";
import { inspectionSubjectKey, type InspectionRecord, type InspectionRelationKind, type InspectionSubjectRef } from "../records/index.js";
import { snapshotInspectionJson, validateInspectionRef } from "../records/InspectionValidation.js";
import { InspectionDatabase, wasInspectionDatasetRetired } from "../storage/index.js";
import { acquireInspectionReadLease } from "../storage/InspectionDatasetAccess.js";
import { validateInspectionCapturePolicy, captureClassEnabled } from "../content/index.js";
import type { InspectionQuery, InspectionReadResult, InspectionGraph } from "./InspectionQuery.js";
import { INSPECTION_FORMAT_VERSION } from "../records/index.js";
import { executeFlowQuery, validateFlowQueryFields } from "./InspectionFlowQuery.js";
import { readInspectionPageCursor, inspectionPageCursor } from "./InspectionPageCursor.js";
import { readIntervals, resolveRunScope, summarizeObjects } from "./InspectionObjectQuery.js";

const viewKinds = ["list_definitions", "list_runs", "list_records", "get_hierarchy", "get_lifecycle", "get_data_flow", "get_dependencies", "get_scheduling", "get_model_request", "get_execution", "get_timeline", "get_telemetry"];
export function validateInspectionQuery(value: unknown): InspectionQuery {
  const copy = snapshotInspectionJson(value, 256 * 1024) as unknown as Record<string, unknown>;
  if (copy === null || typeof copy !== "object" || typeof copy.kind !== "string") throw new Error("inspection_query_invalid");
  const all = ["list_sources", "list_datasets", "get_snapshot", "get_record", "get_subject", "get_content", "get_execution_flow", "list_flow_occurrences", "get_flow_occurrence", ...viewKinds];
  if (!all.includes(copy.kind)) throw new Error("inspection_query_invalid");
  const allowed = copy.kind === "list_sources" ? ["kind"] : copy.kind === "list_datasets" ? ["kind", "sourceId", "after"] : copy.kind === "get_snapshot" ? ["kind", "sourceId", "datasetId", "watermark"] : ["kind", "sourceId", "datasetId", "watermark", "subject", "runId", "includeDescendants", "from", "to", "recordKind", "after", "limit", "recordId", "contentId", "offset", "length", "invocationId", "occurrenceId", "stepId", "cursor"];
  if (Object.keys(copy).some((key) => !allowed.includes(key))) throw new Error("inspection_query_invalid");
  if (copy.kind !== "list_sources") validateOpaqueId(String(copy.sourceId));
  if (!["list_sources", "list_datasets"].includes(copy.kind)) validateOpaqueId(String(copy.datasetId));
  if (!["list_sources", "list_datasets", "get_snapshot"].includes(copy.kind) && (!Number.isSafeInteger(copy.watermark) || Number(copy.watermark) < 0)) throw new Error("inspection_cursor_invalid");
  if (copy.subject !== undefined) {
    validateInspectionRef(copy.subject as InspectionSubjectRef);
    const ref = copy.subject as InspectionSubjectRef;
    if (ref.sourceId !== copy.sourceId || ref.datasetId !== copy.datasetId) throw new Error("inspection_access_denied");
  }
  for (const field of ["recordId", "contentId", "runId", "recordKind"]) if (copy[field] !== undefined && (typeof copy[field] !== "string" || String(copy[field]).length > 512)) throw new Error("inspection_query_invalid");
  for (const field of ["limit", "offset", "length"]) if (copy[field] !== undefined && (!Number.isSafeInteger(copy[field]) || Number(copy[field]) < 0)) throw new Error("inspection_query_invalid");
  if (copy.after !== undefined && (typeof copy.after !== "string" || copy.after.length > 1024)) throw new Error("inspection_cursor_invalid");
  if (Number(copy.limit ?? 100) > 500 || Number(copy.length ?? 262144) > 262144) throw new Error("inspection_query_invalid");
  if (copy.kind === "get_subject" && !copy.subject || copy.kind === "get_record" && !copy.recordId || copy.kind === "get_content" && !copy.contentId) throw new Error("inspection_query_invalid");
  validateFlowQueryFields(copy);
  if (copy.includeDescendants !== undefined && (typeof copy.includeDescendants !== "boolean" || !copy.runId || !viewKinds.includes(copy.kind))) throw new Error("inspection_query_invalid");
  for (const field of ["from", "to"]) if (copy[field] !== undefined && (copy.kind !== "get_timeline" || typeof copy[field] !== "string" || !Number.isFinite(Date.parse(String(copy[field]))))) throw new Error("inspection_query_invalid");
  if (copy.from && copy.to && Date.parse(String(copy.from)) > Date.parse(String(copy.to))) throw new Error("inspection_query_invalid");
  return copy as unknown as InspectionQuery;
}

export function readInspectionJson<T>(path: string): T {
  if (statSync(path).size > 64 * 1024) throw new Error("inspection_dataset_corrupt");
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function directoryNames(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name).sort();
}

export function executeInspectionQuery(root: string, input: InspectionQuery): InspectionReadResult {
  const query = validateInspectionQuery(input);
  const base: InspectionReadResult = { kind: query.kind, selection: null, coverage: null, readAt: new Date().toISOString(), sources: [], datasets: [], records: [], graph: null, intervals: [], telemetry: [], content: null, next: null, limitations: [] };
  if (query.kind === "list_sources") {
    const sources: InspectionSource[] = [];
    const limitations: string[] = [];
    const names = directoryNames(containedInspectionPath(root, "sources"));
    if (names.length > 100) limitations.push("source_catalog_limit");
    for (const id of names.slice(0, 100)) {
      try {
        validateOpaqueId(id);
        const source = readInspectionJson<InspectionSource>(containedInspectionPath(root, "sources", id, "source.json"));
        if (source.sourceId !== id || source.formatVersion !== INSPECTION_FORMAT_VERSION || typeof source.name !== "string" || typeof source.application !== "string") throw new Error();
        sources.push(source);
      } catch { limitations.push("unsupported_source"); }
    }
    return { ...base, sources, limitations };
  }
  const source = readInspectionJson<InspectionSource>(containedInspectionPath(root, "sources", query.sourceId, "source.json"));
  if (source.sourceId !== query.sourceId || source.formatVersion !== INSPECTION_FORMAT_VERSION) throw new Error("inspection_source_unavailable");
  if (query.kind === "list_datasets") {
    const datasets: InspectionDatasetManifest[] = [];
    const limitations: string[] = [];
    const names = directoryNames(containedInspectionPath(root, "sources", query.sourceId, "datasets")).filter((id) => !query.after || id > query.after);
    for (const id of names.slice(0, 100)) {
      try {
        const manifest = readInspectionJson<InspectionDatasetManifest>(containedInspectionPath(datasetDirectory(root, query.sourceId, id), "manifest.json"));
        if (manifest.formatVersion !== INSPECTION_FORMAT_VERSION || manifest.sourceId !== query.sourceId || manifest.datasetId !== id) throw new Error();
        datasets.push(manifest);
      } catch { limitations.push("unsupported_dataset"); }
    }
    return { ...base, datasets, limitations, next: names.length > 100 ? names[99]! : null };
  }
  const directory = datasetDirectory(root, query.sourceId, query.datasetId);
  if (!existsSync(directory)) throw new Error(wasInspectionDatasetRetired(root, query.sourceId, query.datasetId) ? "inspection_dataset_cleared" : "inspection_dataset_unavailable");
  const release = acquireInspectionReadLease(directory);
  let db: InspectionDatabase;
  try { db = new InspectionDatabase(directory); } catch (failure) { release(); throw failure; }
  try {
    if (db.manifest().sourceId !== query.sourceId || db.manifest().datasetId !== query.datasetId) throw new Error("inspection_dataset_corrupt");
    const watermark = query.kind === "get_snapshot" ? query.watermark ?? db.snapshot().watermark : query.watermark;
    const coverage = db.snapshotAt(watermark);
    const result = { ...base, coverage, selection: { sourceId: query.sourceId, datasetId: query.datasetId, watermark } };
    if (query.kind === "get_snapshot") return result;
    if (query.kind === "get_execution_flow" || query.kind === "list_flow_occurrences" || query.kind === "get_flow_occurrence") return executeFlowQuery(db, query, result);
    if (query.kind === "get_record") { const record = db.record(query.recordId, watermark); return { ...result, records: record ? [record] : [], limitations: record ? [] : ["not_observed"] }; }
    if (query.kind === "get_subject") { const record = db.latest(inspectionSubjectKey(query.subject), watermark); return { ...result, records: record ? [record] : [], limitations: record ? [] : ["not_observed"] }; }
    if (query.kind === "get_content") {
      const descriptor = db.content(query.contentId, watermark);
      // Capture absence is a recorded fact, not a denied read of retained bytes.
      if (descriptor?.availability === "present") {
        const policy = validateInspectionCapturePolicy(readInspectionJson(containedInspectionPath(root, "sources", query.sourceId, "read-policy.json")));
        if (!captureClassEnabled(policy, descriptor.class)) throw new Error("inspection_access_denied");
      }
      return { ...result, content: db.readContent(query.contentId, watermark, query.offset ?? 0, query.length ?? 256 * 1024) };
    }
    const after = readInspectionPageCursor(query);
    const nextPage = (sequence: number | undefined) => inspectionPageCursor(query, sequence);
    const key = query.subject ? inspectionSubjectKey(query.subject) : null;
    const runScope = resolveRunScope(db, watermark, query.runId, query.includeDescendants);
    const schedulingRun = query.kind === "get_scheduling" && query.subject?.kind === "run" ? query.subject.id : undefined;
    if (query.kind === "get_lifecycle") {
      const definitions = key ? [db.latest(key, watermark, "lifecycle")].filter((record): record is InspectionRecord => record !== null) : [];
      const transitions = db.records({ watermark, subjectKey: key ?? undefined, kind: "transition", runIds: runScope.runIds, limit: 501, after });
      const records = [...definitions, ...transitions.slice(0, 500)];
      const triggers = records.flatMap(record => record.links.filter(link => link.kind === "trigger").map(link => link.from));
      const relatedRecords = [...new Set(triggers.map(inspectionSubjectKey))].flatMap(target => { const fact = db.latest(target, watermark); return fact ? [fact] : []; });
      return { ...result, records, relatedRecords, next: transitions.length > 500 ? nextPage(transitions[499]!.commitSequence) : null, limitations: transitions.length > 500 ? ["partial_lifecycle_path"] : [] };
    }
    if (query.kind === "get_telemetry") {
      const limit = Math.max(1, query.limit ?? 100);
      const page = db.telemetry(watermark, key, limit + 1, after, runScope.runIds);
      const telemetry = page.slice(0, limit);
      return { ...result, telemetry, next: page.length > limit ? nextPage(telemetry.at(-1)!.sequence) : null };
    }
    if (["get_hierarchy", "get_data_flow", "get_dependencies"].includes(query.kind) || query.kind === "get_execution" && query.subject) {
      const kinds: InspectionRelationKind[] = query.kind === "get_hierarchy" ? ["contains", "descendant", "materializes"] : query.kind === "get_dependencies" ? ["prerequisite"] : query.kind === "get_data_flow" ? ["produces", "transforms", "delivers", "includes", "omits"] : ["materializes", "contains", "binding", "settles", "cause"];
      return { ...result, graph: graph(db, watermark, key, kinds, runScope.runIds), records: query.subject ? db.records({ watermark, subjectKey: key!, limit: 100 }) : [], limitations: runScope.limitations };
    }
    const limit = Math.max(1, query.limit ?? 100);
    const objectKind = query.kind === "get_model_request" ? "request" : query.kind === "get_execution" || query.kind === "get_scheduling" ? "call" : undefined;
    if (objectKind && !query.subject) {
      const page = db.subjects(watermark, objectKind, after, Math.min(limit, 50) + 1, runScope.runIds);
      const policy = validateInspectionCapturePolicy(readInspectionJson(containedInspectionPath(root, "sources", query.sourceId, "read-policy.json")));
      const summaries = summarizeObjects(db, page.slice(0, Math.min(limit, 50)), watermark, policy);
      let bytes = 0;
      const retained = summaries.filter(summary => {bytes += Buffer.byteLength(JSON.stringify(summary)); return bytes <= 1536 * 1024;});
      return {...result, records: retained.map(item => item.record), summaries: retained,
        next: page.length > retained.length ? nextPage(retained.at(-1)?.record.commitSequence) : null,
        limitations: [...runScope.limitations, ...(retained.some(item => item.limited) ? ["object_summary_limited"] : []), ...(retained.length < summaries.length ? ["summary_bytes_limited"] : [])]};
    }
    let records = query.kind === "list_runs" || query.kind === "list_definitions"
      ? db.subjects(watermark, query.kind === "list_runs" ? "run" : "definition", after, limit + 1, query.kind === "list_runs" ? runScope.runIds : undefined)
      : db.records({ watermark, after, limit: limit + 1, runId: schedulingRun, runIds: runScope.runIds, subjectKey: schedulingRun ? undefined : key ?? undefined, kind: query.kind === "get_scheduling" ? "scheduling" : query.kind === "get_timeline" ? "interval" : query.recordKind, intervalStarts: query.kind === "get_timeline" });
    const more = records.length > limit;
    records = records.slice(0, limit);
    let bytes = 0;
    let retained = 0;
    for (const record of records) { bytes += Buffer.byteLength(JSON.stringify(record)); if (bytes > 1536 * 1024) break; retained++; }
    const limited = retained < records.length;
    records = records.slice(0, retained);
    const timed = query.kind === "get_timeline" ? readIntervals(db, records, watermark) : { intervals: [], limitations: [] };
    if (query.kind === "get_timeline" && db.hasUnpairedIntervalEnd(watermark,runScope.runIds,key ?? undefined)) timed.limitations.push("interval_start_not_observed");
    const intervals = timed.intervals.filter(interval => (!query.from || Date.parse(interval.end ?? interval.horizon) >= Date.parse(query.from)) && (!query.to || Date.parse(interval.start) <= Date.parse(query.to)));
    const summaries = query.kind === "list_runs" ? summarizeObjects(db, records, watermark) : undefined;
    if (summaries) {
      let total = 0;
      const kept = summaries.filter(summary=>{total+=Buffer.byteLength(JSON.stringify(summary));return total<=1536*1024;});
      return {...result, records:kept.map(summary=>summary.record), summaries:kept,
        next:more || limited || kept.length<summaries.length ? nextPage(kept.at(-1)?.record.commitSequence) : null,
        limitations:[...runScope.limitations,...(kept.some(summary=>summary.limited)?["object_summary_limited"]:[]),...(kept.length<summaries.length?["summary_bytes_limited"]:[])]};
    }
    return { ...result, records, summaries, next: more || limited ? nextPage(records.at(-1)?.commitSequence) : null, intervals, limitations: [...runScope.limitations, ...timed.limitations, ...(query.kind === "get_timeline" && (more || limited) ? ["partial_interval_page"] : [])] };
  } finally { db.close(); release(); }
}

function graph(db: InspectionDatabase, watermark: number, key: string | null, kinds: readonly InspectionRelationKind[], runIds?: readonly string[]): InspectionGraph {
  const candidates = db.relations(watermark, key, kinds, 0, 1001, runIds);
  const refs = new Map<string, InspectionSubjectRef>();
  if (key) { const selected = db.latest(key, watermark); if (selected) refs.set(key, selected.subject); }
  const links = [];
  for (const link of candidates.slice(0, 1000)) {
    const from = inspectionSubjectKey(link.from); const to = inspectionSubjectKey(link.to);
    const missing = Number(!refs.has(from)) + Number(!refs.has(to) && from !== to);
    if (refs.size + missing > 300) break;
    refs.set(from, link.from); refs.set(to, link.to); links.push(link);
  }
  return { nodes: [...refs].map(([subjectKey, subject]) => { const record = db.latest(subjectKey, watermark); return { subject, record, availability: record ? "present" : "not_observed" }; }), links, limited: links.length < candidates.length, scope: key ? "selected_neighborhood" : "dataset", nodeLimit: 300, edgeLimit: 1000 };
}
