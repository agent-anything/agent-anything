import type { ExecutionFlowSubjectRef } from "@agent-anything/observability/execution-flow";
import type { InspectionSubjectRef } from "./InspectionRecord.js";
import { validateInspectionRef } from "./InspectionValidation.js";

export function inspectionFlowReference(reference: ExecutionFlowSubjectRef, scope: Pick<InspectionSubjectRef, "sourceId" | "datasetId" | "runId">): InspectionSubjectRef {
  const kind = reference.owner === "runtime" && reference.kind === "descendant_relation" ? "contribution" : reference.kind;
  const subject = {...scope, owner: reference.owner, kind: kind as InspectionSubjectRef["kind"], id: reference.id,
    revision: reference.revision, runId: reference.runId === undefined ? scope.runId : reference.runId};
  validateInspectionRef(subject);
  return subject;
}
