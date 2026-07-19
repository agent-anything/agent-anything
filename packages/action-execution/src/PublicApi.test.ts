import type {
  ActionAdapter,
  RunActionContext,
  SandboxProvider,
} from "@agent-anything/action-execution";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as actionExecutionApi from "./index.js";

describe("Action Execution public API", () => {
  it("exposes the trusted Action execution surface without private assessment stages", () => {
    expectTypeOf<ActionAdapter>().toBeObject();
    expectTypeOf<RunActionContext>().toBeObject();
    expectTypeOf<SandboxProvider>().toBeObject();
    expect(Object.keys(actionExecutionApi).sort()).toEqual([
      "ACTION_FINGERPRINT_DOMAIN",
      "ActionContractValidationError",
      "ActionEnforcementPipeline",
      "ActionRegistrationValidationError",
      "CanonicalEncodingError",
      "PREPARED_INVOCATION_FINGERPRINT_DOMAIN",
      "PreparedActionInvocationValidationError",
      "addCapabilityEffect",
      "assertActionExecutorDispatchContext",
      "assertCanonicalActionCoherence",
      "assertPreparedInvocationMatchesExecutor",
      "canonicalEncode",
      "canonicalEndpointKey",
      "canonicalPathIdentityKey",
      "canonicalPathTargetKey",
      "canonicalRemoteToolKey",
      "canonicalRemoteToolTargetKey",
      "capabilityEffectKey",
      "createActionAdapterImplementationSnapshot",
      "createActionEffectSet",
      "createActionFingerprint",
      "createActionRegistrationSnapshot",
      "createCanonicalActionOperation",
      "createCanonicalActorIdentity",
      "createCanonicalEffectivePermissions",
      "createCanonicalEnvironmentIdentity",
      "createCanonicalExecutableIdentity",
      "createCanonicalFileSystemTarget",
      "createCanonicalNetworkEndpoint",
      "createCanonicalPathIdentity",
      "createCanonicalRemoteServerIdentity",
      "createCanonicalRemoteToolIdentity",
      "createCanonicalSha256Digest",
      "createCanonicalWorkspaceIdentity",
      "createCanonicalWorkspaceRootIdentity",
      "createFileBaseline",
      "createPreparedActionInvocation",
      "createPreparedInvocationDigest",
      "createSafeActionSummary",
      "createSandboxExecutionGateway",
      "createTargetStateAssertions",
      "findActionRegistration",
      "mergeTargetStateAssertions",
      "snapshotCapabilityEffect",
      "snapshotRunActionContext",
      "targetStateAssertionKey",
    ]);
  });

  it("does not expose semantic Core, Runtime, or private security-stage values", () => {
    expect(actionExecutionApi).not.toHaveProperty("Runner");
    expect(actionExecutionApi).not.toHaveProperty("RunState");
    expect(actionExecutionApi).not.toHaveProperty("RuntimeEventEmitter");
    expect(actionExecutionApi).not.toHaveProperty("createActionDispatchPlan");
    expect(actionExecutionApi).not.toHaveProperty("createActionPolicyInput");
    expect(actionExecutionApi).not.toHaveProperty("createActionApprovalRequirement");
    expect(actionExecutionApi).not.toHaveProperty("deriveActionAuthority");
    expect(actionExecutionApi).not.toHaveProperty("createSandboxEscalationProposal");
  });
});
