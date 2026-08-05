import type { ProviderRequestBuildContext } from "./controller/index.js";
import type { RunConfig, RunnerDependencies } from "./runner/index.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as controllerApi from "./controller/index.js";
import * as planApi from "./plan/index.js";
import * as retryApi from "./retry/index.js";
import * as runApi from "./run/index.js";
import * as runnerApi from "./runner/index.js";

describe("Agent Core Runtime public API", () => {
  it("keeps every public value on its focused subpath", () => {
    expectTypeOf<ProviderRequestBuildContext>().toBeObject();
    expectTypeOf<RunConfig>().toBeObject();
    expectTypeOf<RunnerDependencies>().toBeObject();
    expect(Object.keys(controllerApi).sort()).toEqual([
      "ControllerError",
      "ProviderBackedController",
      "StructuredOutputError",
    ]);
    expect(Object.keys(planApi).sort()).toEqual([
      "abandonPlan",
      "applyPlanUpdate",
      "assertValidPlanLimits",
      "projectPlan",
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
      "createApprovalRecordSummary",
      "createApprovalRequestSummary",
      "createBlockedRunResult",
      "createCancelledRunResult",
      "createFailedRunResult",
      "createInitialRunPermissionState",
      "createRunCancellationController",
      "createRunFailureCause",
      "createSucceededRunResult",
      "deriveApprovalReviewDeadline",
      "deriveAuthorityCommitDeadline",
      "deriveEffectivePermissionContext",
      "deriveRunDeadline",
      "isReviewCapablePolicy",
      "projectPermissionContext",
      "runFailureCode",
      "runFailureMessage",
      "runFailureMetadata",
      "snapshotResolvedRunPermissionConfig",
      "toRunCancellationSummary",
    ]);
    expect(Object.keys(runnerApi)).toEqual(["Runner"]);
    expect(runnerApi).not.toHaveProperty("ActionEnforcementPipeline");
    expect(runnerApi).not.toHaveProperty("RunState");
    expect(runnerApi).not.toHaveProperty("RuntimeEventEmitter");
  });
});
