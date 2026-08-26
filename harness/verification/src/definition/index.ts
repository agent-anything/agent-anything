export type {
  VerificationAssessmentMethodRef,
  VerificationCompletionDisposition,
  VerificationCompletionHandling,
  VerificationDisclosurePolicy,
  VerificationEvidencePolicy,
  VerificationFailure,
  VerificationFailureStage,
  VerificationNecessity,
  VerificationOwnerRef,
  VerificationRequirement,
  VerificationRequirementCoveragePolicy,
  VerificationRequirementFreshnessPolicy,
  VerificationRequirementLimits,
  VerificationRequirementRef,
  VerificationSensitivity,
  VerificationSpecification,
  VerificationSpecificationRef,
  VerificationTrustedSourceKind,
  VerificationTrustedSourceRef,
} from "./VerificationDefinition.js";
export {
  createVerificationFailure,
  snapshotVerificationRequirement,
  snapshotVerificationSpecification,
} from "./VerificationDefinition.js";
export type {
  MaterializedVerificationProfile,
  VerificationProfile,
  VerificationRequirementTemplate,
} from "./VerificationProfile.js";
export {
  materializeVerificationProfile,
  snapshotVerificationProfile,
} from "./VerificationProfile.js";
