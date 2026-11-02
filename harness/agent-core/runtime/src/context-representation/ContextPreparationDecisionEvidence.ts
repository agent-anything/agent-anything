import {contextProcessObject as ref, contextProcessRelationship as link, type ContextProcessEvidence,
  type ContextProcessRelationship} from "@agent-anything/context/evidence";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {SharedAcceptanceReceipt} from "../activity/SharedAcceptance.js";
import type {ContextPreparationDecisionRecord} from "./ContextPreparationDecisionStore.js";

/** Called by the accepting owner; observers do not reconstruct policy meaning from private JSON. */
export function contextPreparationDecisionEvidence(record: ContextPreparationDecisionRecord,
  admissionRejections: readonly SharedAcceptanceReceipt[]): ContextProcessEvidence {
  const {decision, input, investment} = record, runId = decision.scope.runId;
  const subject = ref("context-representation", decision.id, runId);
  const relationships: ContextProcessRelationship[] = [];
  const related: ContextProcessEvidence["related"][number][] = [];
  const observes = (owner: string, id: string, scope: string | null = runId, revision: string | null = null): void => {
    relationships.push(link("observes", subject, ref(owner, id, scope, revision)));
  };
  observes("context_preparation_policy", decision.id, runId, modelInputValueDigest(record));
  observes("shared_acceptance", record.acceptanceId);
  observes("context_selection", input.scope.id);
  if (investment) {
    relationships.push(link("produces", subject, ref("activity-scheduling", investment.workId, runId)),
      link("produces", subject, ref("activity", investment.pathId, runId)));
    if (investment.previousPathId) observes("activity", investment.previousPathId);
  }
  if (input.current.evidence.owner === "activity" && input.current.evidence.kind === "fact") observes("activity", input.current.evidence.id);
  for (const rejection of input.rejectedInputs ?? []) {
    observes("activity", rejection.evidence.id);
    observes("activity", rejection.stageId);
    observes("shared_acceptance", rejection.evidence.revision);
  }
  for (const receiver of input.inputReceptions ?? []) {
    observes("activity", receiver.pathId);
    if (receiver.inputGap) {
      observes("activity", receiver.inputGap.evidence.id);
      relationships.push(link("observes", ref("context-reception-option", receiver.optionId, runId),
        ref("activity", receiver.inputGap.evidence.id, runId)));
    }
  }
  if (input.observationReport) {
    for (const current of input.observationReport.window.inputs) {
      observes("model-input", current.inputId);
      if (current.evidence.owner === "activity") observes("activity", current.evidence.id);
    }
    for (const cost of input.observationReport.costs) observes("activity", cost.pathId);
  }
  for (const offer of input.methodSupplyReport?.offers ?? []) for (const source of offer.sources) {
    observes("material_custody", source.materialId, null, source.version);
  }
  for (const original of input.methodSupplyReport?.originalWork ?? []) {
    observes("activity", original.pathId); observes("activity-scheduling", original.workId);
  }
  for (const option of input.receptionOptions ?? []) {
    const proposal = ref("context-reception-option", option.id, runId);
    relationships.push(link("observes", subject, proposal));
    related.push({subject: proposal, name: "context.input_reception_option", occurredAt: null, value: option});
    for (const member of option.members) relationships.push(link("observes", proposal, ref("activity", member.pathId, runId)),
      link("observes", proposal, ref("activity-scheduling", member.workId, runId)));
    if (decision.investment.kind === "prepare_input" && decision.investment.optionId === option.id) observes("activity", option.id);
  }
  for (const receipt of admissionRejections) {
    if (receipt.outcome !== "rejected" || receipt.scope !== runId || !input.admissionLimitations?.some(l => l.acceptanceId === receipt.id)) {
      throw new TypeError("context_decision_rejection_evidence_invalid");
    }
    const rejection = ref("shared_acceptance", receipt.id, runId);
    relationships.push(link("observes", subject, rejection));
    related.push({subject: rejection, name: "context.preparation_admission_rejection", occurredAt: null, value: receipt});
  }
  if (decision.foreground.kind === "continue") observes("model-input", decision.foreground.preparedInputId);
  if (decision.investment.kind === "reuse" || decision.investment.kind === "reuse_input") observes("activity", decision.investment.pathId);
  if (decision.foreground.kind === "needs_result") relationships.push(link("prerequisite",
    ref("activity", decision.foreground.pathId, runId), subject, "required_context_result"));
  return {revision: "1", category: "decision", subject,scope:{purpose:decision.scope.purpose,recipient:{runId,recipient:decision.scope.recipient,purpose:decision.scope.purpose}},
    judgment:{foreground:decision.foreground.kind,investment:decision.investment.kind,
      adoption:decision.foreground.kind==="continue"?decision.foreground.adoption:null,
      reason:"reason" in decision.investment?decision.investment.reason:decision.foreground.kind==="limited"?decision.foreground.reason:null,
      reconsiderOn:decision.investment.kind==="defer"?decision.investment.reconsiderOn:[],limitations:decision.limitations,excluded:decision.excluded},
    state: {phase: "settled", status: "decision_accepted"}, relationships, related};
}
