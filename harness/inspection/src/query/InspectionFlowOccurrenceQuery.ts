import type { ExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";
import { inspectionSubjectKey, type InspectionSubjectRef } from "../records/index.js";
import { inspectionFlowReference } from "../records/InspectionFlowReference.js";
import type { InspectionDatabase } from "../storage/index.js";
import type { InspectionFlowOccurrenceRead, InspectionFlowQuery } from "./InspectionQuery.js";

/** Coverage is a read of captured facts, never a reconstruction of owner decisions. */
export function readFlowOccurrence(db: InspectionDatabase, query: InspectionFlowQuery, definition: ExecutionFlowDefinition | null): {
  occurrence: InspectionFlowOccurrenceRead; limitations: string[];
} {
  const facts = db.flowRecords({watermark: query.watermark, runId: query.runId, invocationId: query.invocationId, occurrenceId: query.occurrenceId, limit: 501});
  const limitations: string[] = [];
  if (facts.length > 500) limitations.push("flow_occurrence_coverage_limited");
  const entry = facts.find(record => record.payload.kind === "flow_step" && record.payload.observation.kind === "step_entered");
  const exit = facts.find(record => record.payload.kind === "flow_step" && record.payload.observation.kind === "step_exited");
  const ended = !!exit || db.flowRecords({watermark: query.watermark, runId: query.runId, invocationId: query.invocationId, eventKind: "invocation_exited", limit: 1}).length > 0;
  const stepId = entry?.payload.kind === "flow_step" ? entry.payload.observation.stepId : null;
  const checks = (definition?.steps.find(step => step.id === stepId)?.checks ?? []).map(id => {
    const recordIds = facts.filter(record => record.payload.kind === "flow_constraint" && record.payload.observation.checkId === id).map(record => record.id);
    const availability = recordIds.length ? "recorded" as const : ended ? "not_observed" as const : "pending" as const;
    if (availability === "not_observed") limitations.push("flow_check_not_observed");
    return {id, availability, recordIds};
  });
  if (!entry) limitations.push("flow_entry_not_observed");
  if (ended && !exit) limitations.push("flow_exit_not_observed");
  const references: InspectionFlowOccurrenceRead["references"][number][] = [];
  for (const record of facts.slice(0, 500)) {
    const payload = record.payload;
    const observation = payload.kind === "flow_step" || payload.kind === "flow_constraint" ? payload.observation : null;
    if (!observation) continue;
    const role = observation.kind === "step_entered" ? "input" : observation.kind === "step_exited" ? "output" : "configuration";
    const refs = observation.kind === "step_entered" ? observation.inputs : observation.kind === "step_exited" ? observation.outputs : observation.configuration ? [observation.configuration] : [];
    for (const [position, reference] of refs.entries()) {
      if (references.length >= 128) { limitations.push("flow_references_limited"); break; }
      let subject: InspectionSubjectRef;
      try { subject = inspectionFlowReference(reference, query); } catch {
        limitations.push("flow_reference_unmapped");
        references.push({role, sourceRecordId: record.id, position, reference, availability: "unmapped", recordId: null, contents: []});
        continue;
      }
      // Unversioned subjects are object identities, not historical state snapshots.
      // Later publication is exposed separately, not asserted to be state at use.
      const key = inspectionSubjectKey(subject);
      const atUse = db.material(key, record.commitSequence)
        ?? (reference.revision !== null ? db.material(key, query.watermark) : null)
        ?? db.latest(key, record.commitSequence);
      const target = atUse ?? db.material(key, query.watermark) ?? db.latest(key, query.watermark);
      const observedLater = !atUse && target !== null;
      const descriptor = reference.contentId ? db.content(reference.contentId, query.watermark) : null;
      const contents = reference.contentId ? descriptor ? [descriptor] : [] : target?.contents ?? [];
      if (!target || reference.contentId && !descriptor) limitations.push("flow_reference_not_observed");
      if (observedLater) limitations.push("flow_reference_only_observed_later");
      if (contents.some(content => content.availability !== "present")) limitations.push("flow_content_unavailable");
      if (contents.some(content => content.truncated)) limitations.push("flow_content_truncated");
      references.push({role, sourceRecordId: record.id, position, reference, availability: target && (!reference.contentId || descriptor) ? observedLater ? "observed_later" : "present" : "not_observed", recordId: target?.id ?? null, contents});
    }
  }
  return {
    occurrence: {status: !entry || ended && !exit ? "incomplete" : exit ? "closed" : "open", checks, references},
    limitations: [...new Set(limitations)],
  };
}
