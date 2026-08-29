import type { ProviderRequestBuildContext } from "./controller/index.js";
import type {
  RootRunConfig,
  RunConfig,
  RunnerDependencies,
  RunTreeLimits,
} from "./runner/index.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as controllerApi from "./controller/index.js";
import * as delegationApi from "./delegation/index.js";
import * as instructionsApi from "./instructions/index.js";
import * as planApi from "./plan/index.js";
import * as retryApi from "./retry/index.js";
import * as runApi from "./run/index.js";
import * as runnerApi from "./runner/index.js";
import * as stopApi from "./stop/index.js";
import * as transcriptApi from "./transcript/index.js";

describe("Agent Core Runtime public API", () => {
  it("keeps every public value on its focused subpath", () => {
    expectTypeOf<ProviderRequestBuildContext>().toBeObject();
    expectTypeOf<RunConfig>().toBeObject();
    expectTypeOf<RootRunConfig>().toBeObject();
    expectTypeOf<RunTreeLimits>().toBeObject();
    expectTypeOf<RunnerDependencies>().toBeObject();
    expect(Object.keys(controllerApi).sort()).toEqual([
      "ControllerError",
      "ModelInteractionProjectionError",
      "ProviderBackedController",
      "StructuredOutputError",
      "createControllerModelItems",
      "projectModelInteraction",
      "validateControllerDecision",
    ]);
    expect(Object.keys(delegationApi).sort()).toEqual([
      "DelegationRequestValidationError",
      "DelegationResultValidationError",
      "constructDelegationResult",
      "createDelegationContextMaterial",
      "createDelegationContextPlan",
      "createDelegationLimits",
      "createDelegationResult",
      "createDelegationResultExpectation",
      "deriveDelegationAuthority",
      "deriveDelegationLimits",
      "materializeDelegationRequest",
      "snapshotDelegationAuthorityDerivation",
      "snapshotDelegationAuthorityDimensions",
      "snapshotDelegationContextMaterial",
      "snapshotDelegationContextPlan",
      "snapshotDelegationLimitDerivation",
      "snapshotDelegationLimits",
      "snapshotDelegationPreparation",
      "snapshotDelegationRequest",
      "snapshotDelegationResult",
      "snapshotDelegationResultExpectation",
      "snapshotDelegationSteeringRoute",
    ]);
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
    ]);
    expect(Object.keys(stopApi).sort()).toEqual([
      "assertRunStopReviewLimits",
      "createInitialRunStopReviewState",
      "projectRunStopReview",
      "snapshotRunStopCheck",
      "snapshotRunStopFeedback",
      "snapshotRunStopReviewRecord",
    ]);
    expect(Object.keys(transcriptApi).sort()).toEqual([
      "RunTranscriptRecorder",
      "createRunTranscriptRecord",
    ]);
    expect(Object.keys(retryApi).sort()).toEqual([
      "RetryExecutor",
      "createSystemRetryExecutor",
      "snapshotRetryEvent",
      "snapshotRetryOperation",
      "snapshotRetryPolicy",
      "systemRetryClock",
    ]);
    expect(Object.keys(runApi).sort()).toEqual([
      "assertRunPermissionStateInvariant",
      "createBlockedRunResult",
      "createCancelledRunResult",
      "createFailedRunResult",
      "createInitialRunPermissionState",
      "createRunCancellationController",
      "createRunFailureCause",
      "createRunObservation",
      "createSucceededRunResult",
      "deriveActiveRunStatus",
      "deriveApprovalReviewDeadline",
      "deriveAuthorityCommitDeadline",
      "deriveEffectivePermissionContext",
      "deriveRunDeadline",
      "isReviewCapablePolicy",
      "projectPendingRunSubject",
      "projectPermissionContext",
      "runFailureCode",
      "runFailureMessage",
      "runFailureMetadata",
      "snapshotResolvedRunPermissionConfig",
      "snapshotRunSteeringInput",
      "toRunCancellationSummary",
    ]);
    expect(Object.keys(runnerApi)).toEqual(["Runner"]);
    expect(runnerApi).not.toHaveProperty("ActionEnforcementPipeline");
    expect(runnerApi).not.toHaveProperty("RunState");
    expect(runnerApi).not.toHaveProperty("RuntimeEventEmitter");
    expect(stopApi).not.toHaveProperty("Runner");
    expect(transcriptApi).not.toHaveProperty("Runner");
  });
});
