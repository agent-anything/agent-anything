import type { ProviderRequestBuildContext } from "./decision/index.js";
import type {
  RootRunConfig,
  RunConfig,
  RunExecutionCoordinatorDependencies,
  RunTreeLimits,
} from "./execution-coordinator/index.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as controllerApi from "./decision/index.js";
import * as delegationApi from "./delegation/index.js";
import * as instructionsApi from "./instructions/index.js";
import * as planApi from "./plan/index.js";
import * as retryApi from "./retry/index.js";
import * as runApi from "./run/index.js";
import * as runnerApi from "./execution-coordinator/index.js";
import * as transcriptApi from "./transcript/index.js";
import * as contextApi from "./context-representation/index.js";
import * as accessApi from "./model-access/index.js";
import * as activityApi from "./activity/index.js";

describe("Agent Core Runtime public API", () => {
  it("keeps every public value on its focused subpath", () => {
    expectTypeOf<ProviderRequestBuildContext>().toBeObject();
    expectTypeOf<RunConfig>().toBeObject();
    expectTypeOf<RootRunConfig>().toBeObject();
    expectTypeOf<RunTreeLimits>().toBeObject();
    expectTypeOf<RunExecutionCoordinatorDependencies>().toBeObject();
    expect(Object.keys(controllerApi).sort()).toEqual([
      "TaskDecisionActivityError",
      "ModelInteractionProjectionError",
      "ModelResponseTaskDecisionMaker",
      "StructuredOutputError",
      "canonicalConversationPresentations",
      "createControllerInputDeliveryReceipt",
      "createControllerModelItems",
      "createConversationOpeningReceipt",
      "createInputDeliverySections",
      "createModelConversationSeed",
      "createModelOutputRecoverySection",
      "freezeConversationOpening",
      "importModelConversationSeed",
      "projectModelInteraction",
      "retainInputPresentation",
      "selectConversationPresentations",
      "snapshotTaskDecisionFeedback",
      "snapshotConversationOpeningReceipt",
      "snapshotInputPresentation",
      "snapshotModelConversationSeed",
      "validateTaskDecisionProposal",
    ].sort());
    expect(Object.keys(contextApi).sort()).toEqual(["ContextRepresentationManager", "unsupportedModelInputRecovery", "CONTEXT_INPUT_PREPARATION_PURPOSE", "ContextInputPreparationHandler", "ContextInputPreparationWork", "PreparedInputExecution", "contextInputAcceptance", "firstContextInputPreparationStage", "validatePreparedContextInput", "REPRESENTATION_METHOD_PURPOSE", "RepresentationMethodWork", "quoteRepresentationMethod", "INITIAL_CONTEXT_PREPARATION_POLICY", "contextPreparationApplicabilityKey", "contextPreparationAdmissionKey", "decideContextPreparation", "timingSupportsPreparation", "contextObservationKey", "contextEmpiricalRange", "contextPreparationAcceptance", "contextPreparationAcceptanceId", "contextPreparationReconsideration", "contextPreparationAdoption"].sort());
    expect(Object.keys(accessApi).sort()).toEqual(["ModelRequestAccess", "ModelTransportJournal", "assertModelActivityRequest", "createModelActivityBinding"]);
    expect(Object.keys(activityApi).sort()).toEqual(["ActivityCheckpointError", "ActivityPurposeRegistry", "ActivityHandoffProcessor", "ActivityHandoffPump", "ActivityReconsiderationProcessor",
      "activityToken", "activityCount", "activityFactSourceId", "validateActivityPurpose", "validateActivityPath", "validateActivityStage", "validateActivityExecutor", "validateActivitySchedulingIntent"].sort());
    expect(Object.keys(delegationApi).sort()).toEqual([
      "DelegationRequestValidationError",
      "DelegationResultValidationError",
      "constructDelegationResult",
      "createDelegationContextMaterial",
      "createDelegationContextPlan",
      "createDelegationLimits",
      "createDelegationResult",
      "createDelegationResultExpectation",
      "createDescendantContinuationTargetProjection",
      "createDescendantProgress",
      "deriveDelegationExecutionConstraints",
      "deriveDelegationLimits",
      "materializeDelegationRequest",
      "snapshotDelegationExecutionConstraints",
      "snapshotDelegationExecutionConstraintDimensions",
      "snapshotDelegationContextMaterial",
      "snapshotDelegationContextPlan",
      "snapshotDelegationLimitDerivation",
      "snapshotDelegationLimits",
      "snapshotDelegationPreparation",
      "snapshotDelegationRequest",
      "snapshotDelegationResult",
      "snapshotDelegationResultExpectation",
      "snapshotDelegationResumeRoute",
      "snapshotDelegationSteeringRoute",
      "snapshotDescendantMessageRequest",
    ].sort());
    expect(Object.keys(instructionsApi).sort()).toEqual([
      "assertAgentInstructionBindingMatches",
      "createAgentInstructionBinding",
      "projectAgentInstructionBinding",
      "snapshotAgentInstructionBinding",
      "snapshotAgentInstructionBindingRef",
    ]);
    expect(Object.keys(planApi).sort()).toEqual([
      "abandonPlan",
      "applyPlanUpdate",
      "assertValidPlanLimits",
      "projectPlan",
      "validatePlanUpdate",
    ]);
    expect(Object.keys(transcriptApi).sort()).toEqual([
      "RunTranscriptRecorder",
      "createRunTranscriptRecord",
    ]);
    expect(Object.keys(retryApi).sort()).toEqual([
      "RetryCheckpointError",
      "RetryExecutor",
      "RetryInvocationInvalidatedError",
      "createSystemRetryExecutor",
      "snapshotRetryEvent",
      "snapshotRetryOperation",
      "snapshotRetryPolicy",
      "systemRetryClock",
    ]);
    expect(Object.keys(runApi).sort()).toEqual([
      "assertRunPermissionStateInvariant",
      "createInitialRunPermissionState",
      "createRunCancellationController",
      "createRunFailureCause",
      "createRunObservation",
      "createRunResult",
      "deriveActiveRunStatus",
      "deriveApprovalReviewDeadline",
      "deriveAuthorityCommitDeadline",
      "collectRunAuthorizationBasis",
      "deriveRunDeadline",
      "isReviewCapablePolicy",
      "projectPendingRunSubject",
      "projectPermissionContext",
      "runFailureCode",
      "runFailureMessage",
      "runFailureMetadata",
      "runSettlementCauseCode",
      "runSettlementFailure",
      "sameRunSuspensionRef",
      "snapshotResolvedRunPermissionConfig",
      "snapshotRunCauseSourceRef",
      "snapshotRunResumeRequestInput",
      "snapshotRunSettlement",
      "snapshotRunSettlementCauseRecord",
      "snapshotRunSteeringInput",
      "snapshotRunSuspendRequestInput",
      "toRunCancellationSummary",
    ].sort());
    expect(Object.keys(runnerApi).sort()).toEqual(["RunExecutionCoordinator", "ModelTaskDecisionCoordinator", "DirectTaskDecisionCoordinator", "RunRecoveryError", "retainedRunResult", "RunCommitError", "validateRunTreeCommit", "RunTreeCommitWriter", "RUN_LIFECYCLE_DESCRIPTION", "retainRunConfiguration", "restoreRunConfiguration"].sort());
    expect(runnerApi).not.toHaveProperty("ActionEnforcementPipeline");
    expect(runnerApi).not.toHaveProperty("RunState");
    expect(runnerApi).not.toHaveProperty("RuntimeEventEmitter");
    expect(transcriptApi).not.toHaveProperty("RunExecutionCoordinator");
  });
});
