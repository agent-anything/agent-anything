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
import * as hooksApi from "./hooks/index.js";
import * as instructionsApi from "./instructions/index.js";
import * as lifecycleApi from "./lifecycle/index.js";
import * as planApi from "./plan/index.js";
import * as retryApi from "./retry/index.js";
import * as runApi from "./run/index.js";
import * as runnerApi from "./runner/index.js";
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
      "unsupportedModelInputRecovery",
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
      "createDescendantContinuationTargetProjection",
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
      "snapshotDescendantMessageRequest",
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
      "createInitialRunPermissionState",
      "createRunCancellationController",
      "createRunFailureCause",
      "createRunObservation",
      "createRunResult",
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
      "runSettlementCauseCode",
      "runSettlementFailure",
      "sameRunSuspensionRef",
      "snapshotResolvedRunPermissionConfig",
      "snapshotRunCauseSourceRef",
      "snapshotRunSettlement",
      "snapshotRunSettlementCauseRecord",
      "snapshotRunSteeringInput",
      "toRunCancellationSummary",
    ]);
    expect(Object.keys(runnerApi)).toEqual(["Runner"]);
    expect(Object.keys(hooksApi)).toContain("createEmptyRunLifecycleHookComposition");
    expect(Object.keys(lifecycleApi)).toContain("snapshotStopLifecycleEvent");
    expect(runnerApi).not.toHaveProperty("ActionEnforcementPipeline");
    expect(runnerApi).not.toHaveProperty("RunState");
    expect(runnerApi).not.toHaveProperty("RuntimeEventEmitter");
    expect(hooksApi).not.toHaveProperty("Runner");
    expect(transcriptApi).not.toHaveProperty("Runner");
  });
});
