import { createHash } from "node:crypto";
import { inspectionSubjectKey, type InspectionRecord } from "../records/index.js";
import type { InspectionDatabase } from "../storage/index.js";
import type { InspectionFlowQuery, InspectionReadResult } from "./InspectionQuery.js";

const kinds = ["get_execution_flow", "list_flow_occurrences", "get_flow_occurrence"];
export function validateFlowQueryFields(value: Record<string, unknown>): void {
  const fields = ["invocationId", "occurrenceId", "stepId", "cursor"];
  if (!kinds.includes(String(value.kind))) {
    if (fields.some(field => value[field] !== undefined)) throw new Error("inspection_query_invalid");
    return;
  }
  for (const field of [...fields, "runId"]) if (value[field] !== undefined && (typeof value[field] !== "string" || !value[field] || String(value[field]).length > 512)) throw new Error("inspection_query_invalid");
  if (!value.runId || value.kind !== "get_execution_flow" && !value.invocationId || value.kind === "get_flow_occurrence" && !value.occurrenceId) throw new Error("inspection_query_invalid");
  if (["subject", "after", "recordKind", "recordId", "contentId", "offset", "length"].some(field => value[field] !== undefined)) throw new Error("inspection_query_invalid");
}

function scope(query: InspectionFlowQuery): string {
  return createHash("sha256").update(JSON.stringify([query.kind, query.sourceId, query.datasetId, query.watermark, query.runId, query.invocationId ?? null, query.occurrenceId ?? null, query.stepId ?? null])).digest("hex");
}
function readCursor(query: InspectionFlowQuery): number {
  if (!query.cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
    if (value.scope !== scope(query) || !Number.isSafeInteger(value.after) || value.after < 0 || value.after > query.watermark) throw new Error();
    return value.after;
  } catch { throw new Error("inspection_cursor_invalid"); }
}

export function executeFlowQuery(db: InspectionDatabase, query: InspectionFlowQuery, base: InspectionReadResult): InspectionReadResult {
  const after = readCursor(query);
  const limit = Math.max(1, query.limit ?? 100);
  const filter = {watermark: query.watermark, runId: query.runId, invocationId: query.invocationId};
  const eventKind = query.kind === "list_flow_occurrences" ? "step_entered" : query.kind === "get_execution_flow" ? "invocation_entered" : undefined;
  const page = db.flowRecords({...filter, occurrenceId: query.occurrenceId, stepId: query.stepId, eventKind, after, limit: limit + 1});
  let bytes = 0;
  const records: InspectionRecord[] = [];
  for (const record of page.slice(0, limit)) {
    bytes += Buffer.byteLength(JSON.stringify(record));
    if (bytes > 1024 * 1024) break;
    records.push(record);
  }
  const more = records.length < page.length;
  const pageEnd = records.at(-1)?.commitSequence;
  const first = query.invocationId ? db.flowRecords({...filter, eventKind: "invocation_entered", limit: 1})[0] : null;
  const observation = first?.payload.kind === "flow_invocation" ? first.payload.observation : null;
  const captured = observation ? db.flowDefinition(observation.definition, query.watermark) : null;
  const definition = captured?.payload.kind === "flow_definition" && captured.payload.definition.contentDigest === observation?.definition.contentDigest ? captured.payload.definition : null;
  const selected = query.kind === "get_flow_occurrence" ? records[0] : first;
  const links = selected ? db.relations(query.watermark, inspectionSubjectKey(selected.subject), ["next", "call", "return", "spawn", "join", "resume"], 0, 257) : [];
  const limitations = [...(query.invocationId && !definition ? [captured ? "flow_definition_mismatch" : "flow_definition_not_observed"] : []), ...(links.length > 256 ? ["flow_links_limited"] : []), ...(!records.length && !query.cursor ? ["flow_records_not_observed"] : [])];
  if (query.kind === "get_execution_flow" && query.invocationId) records.push(...db.flowRecords({...filter, eventKind: "invocation_exited", limit: 1}));
  return {
    ...base, records, limitations,
    next: more && pageEnd !== undefined ? Buffer.from(JSON.stringify({scope: scope(query), after: pageEnd})).toString("base64url") : null,
    flow: {definition, steps: query.invocationId ? db.flowStatistics(query.invocationId, query.watermark) : [], transitions: query.invocationId ? db.flowTransitions(query.invocationId, query.watermark) : [], links: links.slice(0, 256)},
  };
}
