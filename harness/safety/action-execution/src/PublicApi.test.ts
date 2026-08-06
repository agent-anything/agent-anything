import { describe, expect, expectTypeOf, it } from "vitest";

import type { ActionAdapter } from "./registration/index.js";
import type { RunActionContext } from "./enforcement/index.js";
import type { SandboxProvider } from "./sandbox/index.js";
import * as canonicalApi from "./canonical/index.js";
import * as registrationApi from "./registration/index.js";
import * as enforcementApi from "./enforcement/index.js";
import * as sandboxApi from "./sandbox/index.js";
import * as executionApi from "./execution/index.js";

describe("Action Execution public API", () => {
  it("exposes focused semantic subpaths", () => {
    expectTypeOf<ActionAdapter>().toBeObject();
    expectTypeOf<RunActionContext>().toBeObject();
    expectTypeOf<SandboxProvider>().toBeObject();

    expect(Object.keys(canonicalApi).sort()).toEqual([
      "ACTION_FINGERPRINT_DOMAIN",
      "ActionContractValidationError",
      "CanonicalEncodingError",
      "PREPARED_INVOCATION_FINGERPRINT_DOMAIN",
      "PreparedActionInvocationValidationError",
      "addCapabilityEffect",
      "assertCanonicalActionCoherence",
      "assertPreparedInvocationMatchesExecutor",
      "canonicalEncode",
      "canonicalEndpointKey",
      "canonicalPathIdentityKey",
      "canonicalPathTargetKey",
      "canonicalRemoteToolKey",
      "canonicalRemoteToolTargetKey",
      "capabilityEffectKey",
      "createActionEffectSet",
      "createActionFingerprint",
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
      "createTargetStateAssertions",
      "mergeTargetStateAssertions",
      "snapshotCapabilityEffect",
      "targetStateAssertionKey",
    ]);
    expect(Object.keys(registrationApi).sort()).toEqual([
      "ActionRegistrationValidationError",
      "ToolActionBindingValidationError",
      "assertToolActionBindingSnapshot",
      "createActionAdapterImplementationSnapshot",
      "createActionRegistrationSnapshot",
      "createEmptyToolActionBindingSnapshot",
      "createToolActionBindingSnapshot",
      "findActionRegistration",
      "findToolActionBinding",
    ]);
    expect(Object.keys(enforcementApi).sort()).toEqual([
      "ActionEnforcementPipeline",
      "snapshotRunActionContext",
    ]);
    expect(Object.keys(sandboxApi).sort()).toEqual([
      "createSandboxExecutionGateway",
    ]);
    expect(Object.keys(executionApi).sort()).toEqual([
      "assertActionExecutorDispatchContext",
      "createActionExecutionFailure",
    ]);
  });

  it("does not expose semantic Core, Runtime, or private security stages", () => {
    const publicApis = [
      canonicalApi,
      registrationApi,
      enforcementApi,
      sandboxApi,
      executionApi,
    ];
    for (const api of publicApis) {
      expect(api).not.toHaveProperty("Runner");
      expect(api).not.toHaveProperty("RunState");
      expect(api).not.toHaveProperty("RuntimeEventEmitter");
      expect(api).not.toHaveProperty("createActionDispatchPlan");
      expect(api).not.toHaveProperty("createActionPolicyInput");
      expect(api).not.toHaveProperty("createActionApprovalRequirement");
      expect(api).not.toHaveProperty("deriveActionAuthority");
      expect(api).not.toHaveProperty("createSandboxEscalationProposal");
      expect(api).not.toHaveProperty("prepareSandboxDispatch");
      expect(api).not.toHaveProperty("settleExecutorResult");
    }
  });
});
