import type { InspectionSubjectRef } from "@agent-anything/inspection/records";
import type { InspectionQuery, InspectionSelection } from "@agent-anything/inspection/query";

export type InspectionDetailTarget =
  | { kind: "record"; recordId: string }
  | { kind: "object"; subject: InspectionSubjectRef }
  | { kind: "relation"; recordId: string; linkId: string };

const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;

export function readInspectionDetailTarget(value: string | null): InspectionDetailTarget | null {
  if (!value || value.length > 8192) return null;
  try {
    const target = JSON.parse(value);
    if (!target || typeof target !== "object") return null;
    if (target.kind === "record" && identity(target.recordId)) return { kind: "record", recordId: target.recordId };
    if (target.kind === "relation" && identity(target.recordId) && identity(target.linkId)) {
      return { kind: "relation", recordId: target.recordId, linkId: target.linkId };
    }
    const ref = target.subject;
    if (target.kind !== "object" || !ref || typeof ref !== "object") return null;
    if (![ref.sourceId, ref.datasetId, ref.owner, ref.kind, ref.id].every(identity)
      || ![ref.runId, ref.revision].every(item => item === null || identity(item))) return null;
    return { kind: "object", subject: { sourceId: ref.sourceId, datasetId: ref.datasetId, owner: ref.owner,
      kind: ref.kind, id: ref.id, runId: ref.runId, revision: ref.revision } };
  } catch { return null; }
}

export function inspectionDetailQuery(target: InspectionDetailTarget, scope: InspectionSelection, after?: string): InspectionQuery {
  return target.kind === "object"
    ? { ...scope, kind: "list_records", subject: target.subject, limit: 20, ...(after ? { after } : {}) }
    : { ...scope, kind: "get_record", recordId: target.recordId };
}

export function inspectionObjectHistoryLocation(subject: InspectionSubjectRef): Record<string, string | null> {
  return { area: subject.kind === "definition" ? "Definitions" : "Runs", view: "Records",
    run: subject.kind === "run" ? subject.id : subject.runId, descendants: null,
    subject: JSON.stringify(subject), record: null, detail: null, content: null,
    flowRun: null, flowInvocation: null, flowOccurrence: null, flowStep: null, dataFocus: null };
}

export function inspectionObjectViewLocation(subject: InspectionSubjectRef, view: "Lifecycle" | "Data Flow" | "Timeline") {
  // A lifecycle belongs to the process, not to one immutable observed revision.
  const target = view === "Lifecycle" && subject.kind === "process" ? {...subject, revision:null} : subject;
  return {...inspectionObjectHistoryLocation(target), view, dataFocus:view === "Data Flow" ? "true":null};
}
