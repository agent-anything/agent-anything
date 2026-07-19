import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const packageExportKeys = {
  "packages/agent-core": [
    ".",
    "./action",
    "./agent",
    "./context",
    "./controller",
    "./events",
    "./plan",
    "./retry",
    "./run",
    "./task",
  ],
  "packages/action-execution": ["."],
  "packages/agent-runtime": ["."],
  "packages/host": ["."],
};

for (const [packagePath, expectedKeys] of Object.entries(packageExportKeys)) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, packagePath, "package.json"), "utf8"));
  assert.deepEqual(
    Object.keys(manifest.exports ?? {}).sort(),
    expectedKeys,
    `${manifest.name} export keys changed without updating the public API contract`,
  );
}

const expectedValueExports = {
  "@agent-anything/agent-core": [],
  "@agent-anything/agent-core/action": [],
  "@agent-anything/agent-core/agent": [],
  "@agent-anything/agent-core/context": [
    "applyContextUpdate",
    "createInitialContext",
    "projectContext",
  ],
  "@agent-anything/agent-core/controller": [],
  "@agent-anything/agent-core/events": [
    "RuntimeEventEmitter",
    "RuntimeEventRecorder",
  ],
  "@agent-anything/agent-core/plan": [
    "abandonPlan",
    "applyPlanUpdate",
    "assertValidPlanLimits",
    "projectPlan",
  ],
  "@agent-anything/agent-core/retry": [
    "snapshotRetryEvent",
    "snapshotRetryOperation",
    "snapshotRetryPolicy",
  ],
  "@agent-anything/agent-core/run": [
    "assertRunPermissionStateInvariant",
    "createApprovalRecordSummary",
    "createApprovalRequestSummary",
    "createBlockedRunResult",
    "createCancelledRunResult",
    "createFailedRunResult",
    "createInitialRunPermissionState",
    "createRunCancellationController",
    "createSucceededRunResult",
    "deriveApprovalReviewDeadline",
    "deriveAuthorityCommitDeadline",
    "deriveEffectivePermissionContext",
    "deriveRunDeadline",
    "isReviewCapablePolicy",
    "projectPermissionContext",
    "snapshotResolvedRunPermissionConfig",
    "toRunCancellationSummary",
  ],
  "@agent-anything/agent-core/task": [],
  "@agent-anything/action-execution": [
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
  ],
  "@agent-anything/agent-runtime": [
    "ControllerError",
    "ProviderBackedController",
    "RetryExecutor",
    "Runner",
    "StructuredOutputError",
    "createSystemRetryExecutor",
    "systemRetryClock",
  ],
  "@agent-anything/host": [
    "HOST_RETRY_EVENT_LIMIT",
    "createHostIdentityProvider",
    "createHostRunProjection",
    "createHostRunProjectionStore",
    "createHostRuntime",
    "createHostTerminalRunProjection",
    "createHostWorkspaceResolver",
    "createInMemoryHostPolicyAmendmentStore",
    "createInMemoryHostSessionAuthorityStore",
    "createUserApprovalReviewBridge",
    "projectRuntimeEventForHost",
    "reduceHostRunProjection",
    "resolveHostRunPermissionConfig",
    "snapshotHostCancellation",
  ],
};

const removedOrPrivateSpecifiers = [
  "@agent-anything/agent-core/runner",
  "@agent-anything/agent-core/action-execution",
  "@agent-anything/agent-core/host",
  "@agent-anything/action-execution/ActionGovernanceAssessment",
  "@agent-anything/agent-runtime/runner",
  "@agent-anything/host/HostRuntime",
];

const childSource = `
  import assert from "node:assert/strict";
  const expected = ${JSON.stringify(expectedValueExports)};
  for (const [specifier, expectedKeys] of Object.entries(expected)) {
    const api = await import(specifier);
    assert.deepEqual(Object.keys(api).sort(), expectedKeys, specifier + " value exports changed");
  }
  for (const specifier of ${JSON.stringify(removedOrPrivateSpecifiers)}) {
    let unavailable = false;
    try {
      await import(specifier);
    } catch {
      unavailable = true;
    }
    assert.equal(unavailable, true, specifier + " must not be importable");
  }
`;

const result = spawnSync(
  process.execPath,
  ["--input-type=module", "--eval", childSource],
  {
    cwd: join(repoRoot, "apps/helarc-desktop"),
    encoding: "utf8",
  },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.stdout.write(result.stdout);
  process.exit(result.status ?? 1);
}

console.log("Built public API check passed.");
