import type { ContextContinuityFailureAttribution } from "./ContextContinuityEvaluationContracts.js";

export interface ContextContinuityFailureSignals {
  readonly missingContribution?: boolean;
  readonly admissionRejected?: boolean;
  readonly transitionRejected?: boolean;
  readonly runCancelled?: boolean;
  readonly projectionOmitted?: boolean;
  readonly toolUnavailable?: boolean;
  readonly toolNotExposed?: boolean;
  readonly providerTransportFailed?: boolean;
  readonly modelReasoningFailed?: boolean;
  readonly executionFailed?: boolean;
  readonly validationFailed?: boolean;
}

export function classifyContextContinuityFailure(
  input: ContextContinuityFailureSignals,
): ContextContinuityFailureAttribution {
  if (input.missingContribution === true) return "missing_contribution";
  if (input.admissionRejected === true) return "admission_rejection";
  if (input.transitionRejected === true) return "context_transition";
  if (input.runCancelled === true) return "run_control";
  if (input.projectionOmitted === true) return "projection_omission";
  if (input.toolUnavailable === true) return "tool_availability";
  if (input.toolNotExposed === true) return "tool_exposure";
  if (input.providerTransportFailed === true) return "provider_transport";
  if (input.modelReasoningFailed === true) return "model_reasoning";
  if (input.executionFailed === true) return "execution";
  if (input.validationFailed === true) return "validation";
  return "none";
}
