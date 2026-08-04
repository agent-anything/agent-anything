import type {
  ProviderRequestBuildContext,
  RunConfig,
  RunnerDependencies,
} from "@agent-anything/runtime";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as runtimeApi from "./index.js";

describe("Runtime public API", () => {
  it("exports Runtime-owned semantics without forwarding peer component values", () => {
    expectTypeOf<ProviderRequestBuildContext>().toBeObject();
    expectTypeOf<RunConfig>().toBeObject();
    expectTypeOf<RunnerDependencies>().toBeObject();
    expect(Object.keys(runtimeApi).sort()).toEqual([
      "ControllerError",
      "ProviderBackedController",
      "RetryExecutor",
      "Runner",
      "StructuredOutputError",
      "abandonPlan",
      "applyPlanUpdate",
      "assertRunPermissionStateInvariant",
      "assertValidPlanLimits",
      "createApprovalRecordSummary",
      "createApprovalRequestSummary",
      "createBlockedRunResult",
      "createCancelledRunResult",
      "createFailedRunResult",
      "createInitialRunPermissionState",
      "createRunCancellationController",
      "createRunFailureCause",
      "createSucceededRunResult",
      "createSystemRetryExecutor",
      "deriveApprovalReviewDeadline",
      "deriveAuthorityCommitDeadline",
      "deriveEffectivePermissionContext",
      "deriveRunDeadline",
      "isReviewCapablePolicy",
      "projectPermissionContext",
      "projectPlan",
      "runFailureCode",
      "runFailureMessage",
      "runFailureMetadata",
      "snapshotResolvedRunPermissionConfig",
      "snapshotRetryEvent",
      "snapshotRetryOperation",
      "snapshotRetryPolicy",
      "systemRetryClock",
      "toRunCancellationSummary",
    ]);
    expect(runtimeApi).not.toHaveProperty("ActionEnforcementPipeline");
    expect(runtimeApi).not.toHaveProperty("RunState");
    expect(runtimeApi).not.toHaveProperty("RuntimeEventEmitter");
  });
});
