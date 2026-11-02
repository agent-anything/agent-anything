import {createHash} from "node:crypto";
import {validateOpaqueId} from "../sources/index.js";
import {validateInspectionRef} from "../records/InspectionValidation.js";
import {INSPECTION_PROCESS_CATEGORIES} from "../records/index.js";
import {PROCESS_QUERY_KINDS, type InspectionProcessQuery, type InspectionProcessScopeQuery} from "./InspectionProcessQuery.js";

const invalid = (): never => {throw new Error("inspection_query_invalid");};
function object(value: unknown): Record<string, unknown> {if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>;}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {if (Object.keys(value).some(k => !allowed.includes(k))) invalid();}
function token(value: unknown): void {if (typeof value !== "string" || !value.length || value.length > 512) invalid();}
function opaque(value:unknown):void {if(typeof value!=="string")invalid();validateOpaqueId(value as string);}
function integer(value: unknown, min: number, max: number): void {if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid();}
export const isProcessQuery = (kind: string): boolean => PROCESS_QUERY_KINDS.includes(kind as never) || kind === "open_process_scope" || kind === "get_process_content";

export function validateProcessQuery(copy: Record<string, unknown>): InspectionProcessQuery | InspectionProcessScopeQuery {
  if (copy.kind === "open_process_scope") {
    keys(copy, ["kind", "recordings"]); validateRecordings(copy.recordings, true);
  } else {
    const manifest = object(copy.manifest);
    keys(manifest, ["version", "projectionVersion", "recordings"]);
    if (manifest.version !== "1" || manifest.projectionVersion !== "1") throw new Error("inspection_process_projection_unsupported");
    validateRecordings(manifest.recordings, false);
    if (copy.kind === "get_process_content") {
      keys(copy, ["kind", "manifest", "location", "offset", "length"]);
      const loc = object(copy.location); keys(loc, ["sourceId", "datasetId", "recordId", "contentId"]);
      for (const key of ["sourceId", "datasetId", "contentId"]) opaque(loc[key]);
      token(loc.recordId);
      if (copy.offset !== undefined) integer(copy.offset, 0, Number.MAX_SAFE_INTEGER);
      if (copy.length !== undefined) integer(copy.length, 4, 262144);
    } else {
      keys(copy, ["kind", "manifest", "section", "runId", "runIds", "categories", "fromSequence", "throughSequence", "purpose", "recipient", "subject", "recordId", "evidence", "category", "after", "limit"]);
      if (!PROCESS_QUERY_KINDS.includes(copy.kind as never) || !["facts", "relationships", "variants"].includes(String(copy.section))) invalid();
      for (const key of ["runId", "purpose"]) if (copy[key] !== undefined) token(copy[key]);
      if(copy.runIds!==undefined){if(copy.runId!==undefined||!Array.isArray(copy.runIds)||!copy.runIds.length||copy.runIds.length>64||new Set(copy.runIds).size!==copy.runIds.length)invalid();for(const id of copy.runIds as unknown[])token(id);}
      if(copy.categories!==undefined){if(copy.category!==undefined||!Array.isArray(copy.categories)||!copy.categories.length||copy.categories.length>INSPECTION_PROCESS_CATEGORIES.length||new Set(copy.categories).size!==copy.categories.length)invalid();for(const category of copy.categories as unknown[])if(!INSPECTION_PROCESS_CATEGORIES.includes(category as never))invalid();}
      for(const k of ["fromSequence","throughSequence"])if(copy[k]!==undefined)integer(copy[k],0,Number.MAX_SAFE_INTEGER);
      if(copy.fromSequence!==undefined&&copy.throughSequence!==undefined&&Number(copy.fromSequence)>Number(copy.throughSequence))invalid();
      if (copy.recipient !== undefined) {const r = object(copy.recipient); keys(r, ["runId", "recipient", "purpose"]); for (const k of ["runId", "recipient", "purpose"]) token(r[k]);}
      if (copy.subject !== undefined) validateInspectionRef(copy.subject as never);
      if(copy.recordId!==undefined){token(copy.recordId);if(!copy.subject||copy.section!=="facts")invalid();}
      if (copy.evidence !== undefined) {
        const e = object(copy.evidence); keys(e, ["origin", "digest"]); token(e.digest);
        const o = object(e.origin); keys(o, ["owner", "id", "runId", "revision"]);
        for (const k of ["owner", "id", "revision"]) token(o[k]); if (o.runId !== null) token(o.runId);
      }
      if (copy.subject !== undefined && copy.evidence !== undefined) invalid();
      if (copy.category !== undefined && !INSPECTION_PROCESS_CATEGORIES.includes(copy.category as never)) invalid();
      if (copy.limit !== undefined) integer(copy.limit, 1, 100);
      if (copy.after !== undefined && (typeof copy.after !== "string" || copy.after.length > 1024)) invalid();
      if (copy.section === "variants" && !copy.evidence) invalid();
      if (copy.section === "relationships" && !copy.subject && !copy.evidence) invalid();
      if (!["list_context_process", "get_process_observations", "get_recovery_review"].includes(String(copy.kind)) && !copy.subject && !copy.evidence) invalid();
      if (!copy.subject && !copy.evidence && !copy.runId && !copy.runIds && !copy.recipient) invalid();
    }
  }
  return copy as unknown as InspectionProcessQuery | InspectionProcessScopeQuery;
}

function validateRecordings(value: unknown, opening: boolean): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) invalid();
  const previous = new Set<string>();
  for (const [i, item] of (value as unknown[]).entries()) {
    const r = object(item); keys(r, opening?["sourceId", "datasetId", "watermark", "via"]:["sourceId", "datasetId", "watermark", "projectionWatermark", "via"]);
    opaque(r.sourceId); opaque(r.datasetId);
    const key = JSON.stringify([r.sourceId, r.datasetId]); if (previous.has(key)) invalid();
    if (!opening || r.watermark !== undefined) integer(r.watermark, 0, Number.MAX_SAFE_INTEGER);
    if(!opening)integer(r.projectionWatermark,0,Number(r.watermark));
    if (i === 0) {if (r.via !== null) invalid();}
    else {
      const via = object(r.via); keys(via, ["sourceId", "datasetId", "recordId", "linkId"]);
      if (!previous.has(JSON.stringify([via.sourceId, via.datasetId]))) invalid();
      token(via.recordId); if (via.linkId !== null) token(via.linkId);
    }
    previous.add(key);
  }
}

export interface ProcessCursor {readonly recording: number; readonly sequence: number; readonly key: string;}
export function processQueryDigest(query: InspectionProcessQuery): string {
  const {after: _, ...scope} = query;
  return createHash("sha256").update(JSON.stringify(scope, (_k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)).digest("hex");
}
export function readProcessCursor(query: InspectionProcessQuery): ProcessCursor {
  if (!query.after) return {recording: 0, sequence: 0, key: ""};
  try {
    const v = JSON.parse(Buffer.from(query.after, "base64url").toString("utf8"));
    if (v.scope !== processQueryDigest(query) || !Number.isSafeInteger(v.recording) || v.recording < 0 || v.recording >= query.manifest.recordings.length ||
      !Number.isSafeInteger(v.sequence) || v.sequence < 0 || v.sequence > query.manifest.recordings[v.recording]!.projectionWatermark || typeof v.key !== "string" || v.key.length > 512) throw new Error();
    return {recording: v.recording, sequence: v.sequence, key: v.key};
  } catch {throw new Error("inspection_cursor_invalid");}
}
export function processCursor(query: InspectionProcessQuery, cursor: ProcessCursor): string {
  return Buffer.from(JSON.stringify({scope: processQueryDigest(query), ...cursor})).toString("base64url");
}
export function recordingKey(value: {sourceId: string; datasetId: string}): string {return JSON.stringify([value.sourceId, value.datasetId]);}
