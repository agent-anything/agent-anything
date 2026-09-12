import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { containedInspectionPath, datasetDirectory, validateOpaqueId, type InspectionSource, type InspectionDatasetManifest } from "../sources/index.js";
import { inspectionSubjectKey, type InspectionRecord, type InspectionRelationKind, type InspectionSubjectRef } from "../records/index.js";
import { snapshotInspectionJson, validateInspectionRef } from "../records/InspectionValidation.js";
import { InspectionDatabase, wasInspectionDatasetRetired } from "../storage/index.js";
import { acquireInspectionReadLease } from "../storage/InspectionDatasetAccess.js";
import { validateInspectionCapturePolicy, captureClassEnabled } from "../content/index.js";
import type { InspectionQuery, InspectionReadResult, InspectionGraph, InspectionTimelineInterval } from "./InspectionQuery.js";
import { INSPECTION_FORMAT_VERSION } from "../records/index.js";
import { executeFlowQuery, validateFlowQueryFields } from "./InspectionFlowQuery.js";

const viewKinds = ["list_definitions", "list_runs", "list_records", "get_hierarchy", "get_lifecycle", "get_data_flow", "get_dependencies", "get_scheduling", "get_model_request", "get_execution", "get_timeline", "get_telemetry"];
export function validateInspectionQuery(value: unknown): InspectionQuery {
  const copy = snapshotInspectionJson(value, 256 * 1024) as unknown as Record<string, unknown>;
  if (copy === null || typeof copy !== "object" || typeof copy.kind !== "string") throw new Error("inspection_query_invalid");
  const all = ["list_sources", "list_datasets", "get_snapshot", "get_record", "get_subject", "get_content", "get_execution_flow", "list_flow_occurrences", "get_flow_occurrence", ...viewKinds];
  if (!all.includes(copy.kind)) throw new Error("inspection_query_invalid");
  const allowed = copy.kind === "list_sources" ? ["kind"] : copy.kind === "list_datasets" ? ["kind", "sourceId", "after"] : copy.kind === "get_snapshot" ? ["kind", "sourceId", "datasetId", "watermark"] : ["kind", "sourceId", "datasetId", "watermark", "subject", "runId", "recordKind", "after", "limit", "recordId", "contentId", "offset", "length", "invocationId", "occurrenceId", "stepId", "cursor"];
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
  if (copy.kind !== "list_datasets" && copy.after !== undefined && (!Number.isSafeInteger(copy.after) || Number(copy.after) < 0)) throw new Error("inspection_cursor_invalid");
  if (Number(copy.limit ?? 100) > 500 || Number(copy.length ?? 262144) > 262144) throw new Error("inspection_query_invalid");
  if (copy.kind === "get_subject" && !copy.subject || copy.kind === "get_record" && !copy.recordId || copy.kind === "get_content" && !copy.contentId) throw new Error("inspection_query_invalid");
  validateFlowQueryFields(copy);
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
    const key = query.subject ? inspectionSubjectKey(query.subject) : null;
    const schedulingRun = query.kind === "get_scheduling" && query.subject?.kind === "run" ? query.subject.id : undefined;
    if (query.kind === "get_lifecycle") {
      const definitions = key ? [db.latest(key, watermark, "lifecycle")].filter((record): record is InspectionRecord => record !== null) : [];
      const transitions = db.records({ watermark, subjectKey: key ?? undefined, kind: "transition", limit: 501, after: query.after });
      return { ...result, records: [...definitions, ...transitions.slice(0, 500)], next: transitions.length > 500 ? transitions[499]!.commitSequence : null, limitations: transitions.length > 500 ? ["partial_lifecycle_path"] : [] };
    }
    if (query.kind === "get_telemetry") {
      const limit = Math.max(1, query.limit ?? 100);
      const page = db.telemetry(watermark, key, limit + 1, query.after ?? 0);
      const telemetry = page.slice(0, limit);
      return { ...result, telemetry, next: page.length > limit ? telemetry.at(-1)!.sequence : null };
    }
    if (["get_hierarchy", "get_data_flow", "get_dependencies", "get_execution"].includes(query.kind)) {
      const kinds: InspectionRelationKind[] = query.kind === "get_hierarchy" ? ["contains", "descendant", "materializes"] : query.kind === "get_dependencies" ? ["prerequisite"] : query.kind === "get_data_flow" ? ["produces", "transforms", "delivers", "includes", "omits"] : ["materializes", "contains", "binding", "settles", "cause"];
      return { ...result, graph: graph(db, watermark, key, kinds), records: query.subject ? db.records({ watermark, subjectKey: key!, limit: 100 }) : [] };
    }
    const limit = Math.max(1, query.limit ?? 100);
    let records = query.kind === "list_runs" || query.kind === "list_definitions"
      ? db.subjects(watermark, query.kind === "list_runs" ? "run" : "definition", query.after ?? 0, limit + 1)
      : db.records({ watermark, after: query.after, limit: limit + 1, runId: schedulingRun ?? query.runId, subjectKey: schedulingRun ? undefined : key ?? undefined, kind: query.kind === "get_scheduling" ? "scheduling" : query.kind === "get_timeline" ? "interval" : query.recordKind });
    const more = records.length > limit;
    records = records.slice(0, limit);
    let bytes = 0;
    let retained = 0;
    for (const record of records) { bytes += Buffer.byteLength(JSON.stringify(record)); if (bytes > 1536 * 1024) break; retained++; }
    const limited = retained < records.length;
    records = records.slice(0, retained);
    const timed = query.kind === "get_timeline" ? timeline(records) : { intervals: [], limitations: [] };
    return { ...result, records, next: more || limited ? records.at(-1)?.commitSequence ?? null : null, intervals: timed.intervals, limitations: [...timed.limitations, ...(query.kind === "get_timeline" && (more || limited) ? ["partial_interval_page"] : [])] };
  } finally { db.close(); release(); }
}

function graph(db: InspectionDatabase, watermark: number, key: string | null, kinds: readonly InspectionRelationKind[]): InspectionGraph {
  const candidates = db.relations(watermark, key, kinds, 0, 1001);
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

function timeline(records: readonly InspectionRecord[]): { intervals: InspectionTimelineInterval[]; limitations: string[] } {
  const pending = new Map<string, InspectionRecord>();
  const intervals: InspectionTimelineInterval[] = [];
  const horizon = new Map<string, string>();
  const limitations = new Set<string>();
  for (const record of records) {
    if (record.payload.kind !== "interval") continue;
    if (!record.occurredAt) { limitations.add("interval_timestamp_not_recorded"); continue; }
    const clock = record.payload.clock;
    if ((horizon.get(clock) ?? "") < record.occurredAt) horizon.set(clock, record.occurredAt);
    const key = `${inspectionSubjectKey(record.subject)}:${record.payload.activity}:${clock}`;
    if (record.payload.phase === "started") { if (pending.has(key)) limitations.add("interval_start_without_settlement"); pending.set(key, record); }
    else {
      const start = pending.get(key);
      if (!start?.occurredAt) { limitations.add("interval_start_not_in_snapshot_page"); continue; }
      if (Date.parse(record.occurredAt) < Date.parse(start.occurredAt)) { limitations.add("source_clock_regression"); pending.delete(key); continue; }
      intervals.push({ id: start.id, subject: start.subject, activity: record.payload.activity, clock, start: start.occurredAt, end: record.occurredAt, horizon: record.occurredAt, startRecordId: start.id, endRecordId: record.id, status: record.payload.status });
      pending.delete(key);
    }
  }
  for (const start of pending.values()) if (start.payload.kind === "interval") intervals.push({ id: start.id, subject: start.subject, activity: start.payload.activity, clock: start.payload.clock, start: start.occurredAt!, end: null, horizon: horizon.get(start.payload.clock) ?? start.occurredAt!, startRecordId: start.id, endRecordId: null, status: null });
  return { intervals, limitations: [...limitations] };
}
