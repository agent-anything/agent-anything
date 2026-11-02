import type {InspectionReadManifest, InspectionProcessQuery} from "@agent-anything/inspection/query";
import type {InspectionSubjectRef} from "@agent-anything/inspection/records";
import {readInspectionDetailTarget} from "../navigation/InspectionDetailTarget.js";

export const processViews = ["Decisions / Inputs", "Information Flow", "Methods / Cooperation", "Adoption / Recovery", "Time / Cost", "Evaluation"] as const;
export type ProcessView = typeof processViews[number];
export const viewCategories: Record<ProcessView, NonNullable<InspectionProcessQuery["categories"]>> = {
  "Decisions / Inputs": ["demand", "decision", "selection", "input"],
  "Information Flow": ["source", "representation", "delivery", "material"],
  "Methods / Cooperation": ["method", "coordination", "responsibility"],
  "Adoption / Recovery": ["selection", "input", "recovery", "responsibility"],
  "Time / Cost": ["measurement", "timing"],
  "Evaluation": [],
};
export function readProcessValue<T>(value: string | null): T | null {
  if (!value || value.length > 48000) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}
export function processLocation(subject: InspectionSubjectRef): Record<string, string | null> {
  return {area: "Context Process", view: null, cpFocus: JSON.stringify(subject), cpPage: null, cpTab: null, cpFocusPage: null,
    cpView: "Decisions / Inputs", detail: null, content: null};
}
export function processRunIds(value: string | null, runId?: string): string[] {
  const parsed = readProcessValue<unknown>(value);
  return Array.isArray(parsed) && parsed.length <= 64 && parsed.every(id => typeof id === "string" && id.length <= 512)
    ? [...new Set(parsed)] : runId ? [runId] : [];
}
export function processManifest(value: string | null): InspectionReadManifest | null {
  const parsed = readProcessValue<InspectionReadManifest>(value);
  return parsed?.version === "1" && parsed.projectionVersion === "1" && Array.isArray(parsed.recordings) && parsed.recordings.length > 0 && parsed.recordings.length <= 16 &&
    parsed.recordings.every(r=>r && typeof r.sourceId==="string" && typeof r.datasetId==="string" && Number.isSafeInteger(r.watermark) && r.watermark>=0 && Number.isSafeInteger(r.projectionWatermark) && r.projectionWatermark>=0 && r.projectionWatermark<=r.watermark) ? parsed : null;
}
export function processSubject(value:string|null):InspectionSubjectRef|null {
  const ref=readProcessValue<unknown>(value);
  const target=readInspectionDetailTarget(JSON.stringify({kind:"object",subject:ref}));
  return target?.kind==="object"?target.subject:null;
}
