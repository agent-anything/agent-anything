import { createHash } from "node:crypto";
import { inspectionSubjectKey } from "../records/index.js";
import type { InspectionQuery, InspectionViewQuery } from "./InspectionQuery.js";
type View = Extract<InspectionQuery, {kind:InspectionViewQuery}>;
const scope = (query:View) => createHash("sha256").update(JSON.stringify([
  query.kind,query.sourceId,query.datasetId,query.watermark,query.subject ? inspectionSubjectKey(query.subject):null,
  query.runId ?? null,query.includeDescendants ?? false,query.recordKind ?? null,query.from ?? null,query.to ?? null,
])).digest("hex");
export function readInspectionPageCursor(query:View): number {
  if (query.after === undefined) return 0;
  try {
    const value=JSON.parse(Buffer.from(query.after,"base64url").toString("utf8"));
    if(value.scope!==scope(query)||!Number.isSafeInteger(value.after)||value.after<0||value.after>query.watermark) throw new Error();
    return value.after;
  } catch {throw new Error("inspection_cursor_invalid");}
}
export function inspectionPageCursor(query:View, after:number|undefined):string|null {
  return after===undefined ? null : Buffer.from(JSON.stringify({scope:scope(query),after})).toString("base64url");
}
