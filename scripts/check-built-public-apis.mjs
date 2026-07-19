import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const packageExportKeys = {
  "packages/shared": ["."],
  "packages/tools": [".", "./catalog"],
  "packages/evidence": ["."],
  "packages/governance": [
    ".",
    "./amendment",
    "./identity",
    "./managed-permission",
    "./policy",
    "./workspace",
  ],
  "packages/permission": [".", "./approval", "./authority", "./profile"],
  "packages/observability": [".", "./audit", "./redaction", "./telemetry"],
  "packages/providers": ["."],
  "packages/storage": ["."],
  "packages/testing": ["."],
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
  "packages/code-agent": [".", "./command", "./filesystem", "./patch", "./workspace"],
  "packages/extensions": [
    ".",
    "./enterprise-storage",
    "./mcp",
    "./plugins",
    "./remote-actions",
    "./remote-tools",
  ],
  "products/helarc": ["."],
};

for (const [packagePath, expectedKeys] of Object.entries(packageExportKeys)) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, packagePath, "package.json"), "utf8"));
  assert.deepEqual(
    Object.keys(manifest.exports ?? {}).sort(),
    expectedKeys,
    `${manifest.name} export keys changed without updating the public API contract`,
  );
}

const expectedLowerValueExports = {
  "@agent-anything/shared": [],
  "@agent-anything/tools": [
    "ToolCatalogValidationError",
    "createToolCatalogSnapshot",
    "findToolDescriptor",
  ],
  "@agent-anything/tools/catalog": [
    "ToolCatalogValidationError",
    "createToolCatalogSnapshot",
    "findToolDescriptor",
  ],
  "@agent-anything/evidence": ["EvidenceBuilder"],
  "@agent-anything/governance": [
    "createAllowAllActionPolicyPort",
    "createAnonymousIdentityProvider",
    "createDefaultWorkspaceResolver",
    "evaluateExecPolicyRules",
    "evaluateNetworkPolicyRules",
    "normalizePolicyAmendment",
    "snapshotExecPolicyRule",
    "snapshotNetworkPolicyRule",
  ],
  "@agent-anything/governance/policy": [
    "createAllowAllActionPolicyPort",
    "evaluateExecPolicyRules",
    "evaluateNetworkPolicyRules",
    "snapshotExecPolicyRule",
    "snapshotNetworkPolicyRule",
  ],
  "@agent-anything/governance/workspace": ["createDefaultWorkspaceResolver"],
  "@agent-anything/governance/identity": ["createAnonymousIdentityProvider"],
  "@agent-anything/governance/managed-permission": [],
  "@agent-anything/governance/amendment": ["normalizePolicyAmendment"],
  "@agent-anything/permission": [
    "ApprovalContractError",
    "BUILT_IN_PERMISSION_PROFILE_IDS",
    "PermissionProfileResolutionError",
    "allowsActionApproval",
    "canonicalizeAdditionalPermissions",
    "canonicalizePermissionAbsolutePath",
    "canonicalizePermissionDomain",
    "canonicalizePermissionDomains",
    "canonicalizePermissionFileSystemTarget",
    "canonicalizePermissionPathFromCwd",
    "createActionApprovalCoverage",
    "createApprovalRequest",
    "isActionApprovalCoverageApplicable",
    "isSessionAuthorityApplicable",
    "matchesPermissionDomainPattern",
    "matchesPermissionFileSystemTarget",
    "projectApprovalReviewRequest",
    "projectControllerPermissionProfile",
    "projectPermissionProfile",
    "resolvePermissionProfile",
    "resolvePermissionWorkspaceRoots",
    "snapshotApprovalDecisionSubmission",
    "snapshotApprovalInterruption",
    "snapshotApprovalPayload",
    "snapshotApprovalReviewContext",
    "snapshotApprovalReviewFailure",
    "snapshotApprovalReviewInput",
    "snapshotApprovalReviewerDescriptor",
    "validateApprovalDecision",
    "validateGrantedPermissions",
    "validateSessionAuthorityRecord",
  ],
  "@agent-anything/permission/profile": [
    "BUILT_IN_PERMISSION_PROFILE_IDS",
    "PermissionProfileResolutionError",
    "canonicalizePermissionAbsolutePath",
    "canonicalizePermissionDomain",
    "canonicalizePermissionDomains",
    "canonicalizePermissionFileSystemTarget",
    "canonicalizePermissionPathFromCwd",
    "matchesPermissionDomainPattern",
    "matchesPermissionFileSystemTarget",
    "projectControllerPermissionProfile",
    "projectPermissionProfile",
    "resolvePermissionProfile",
    "resolvePermissionWorkspaceRoots",
  ],
  "@agent-anything/permission/approval": [
    "ApprovalContractError",
    "allowsActionApproval",
    "canonicalizeAdditionalPermissions",
    "createApprovalRequest",
    "projectApprovalReviewRequest",
    "snapshotApprovalDecisionSubmission",
    "snapshotApprovalInterruption",
    "snapshotApprovalPayload",
    "snapshotApprovalReviewContext",
    "snapshotApprovalReviewFailure",
    "snapshotApprovalReviewInput",
    "snapshotApprovalReviewerDescriptor",
    "validateApprovalDecision",
    "validateGrantedPermissions",
  ],
  "@agent-anything/permission/authority": [
    "createActionApprovalCoverage",
    "isActionApprovalCoverageApplicable",
    "isSessionAuthorityApplicable",
    "validateSessionAuthorityRecord",
  ],
  "@agent-anything/observability": [
    "Redactor",
    "createAuditRecord",
    "createTelemetryRecord",
    "defaultRedactionRules",
  ],
  "@agent-anything/observability/audit": ["createAuditRecord"],
  "@agent-anything/observability/telemetry": ["createTelemetryRecord"],
  "@agent-anything/observability/redaction": ["Redactor", "defaultRedactionRules"],
  "@agent-anything/providers": [
    "createProviderAttemptInterruption",
    "providerResultFromInterruption",
  ],
  "@agent-anything/storage": ["InMemoryStorage"],
  "@agent-anything/testing": [
    "FakeApprovalReviewer",
    "FakeAuditPort",
    "FakeIdentityProvider",
    "FakeProvider",
    "FakeTelemetryPort",
    "FakeWorkspaceResolver",
  ],
};

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
  "@agent-anything/code-agent": [
    "CODE_AGENT_CREATE_FILE_ACTION",
    "CODE_AGENT_DELETE_FILE_ACTION",
    "CODE_AGENT_LIST_FILES_ACTION",
    "CODE_AGENT_READ_FILE_ACTION",
    "CODE_AGENT_RUN_COMMAND_ACTION",
    "CODE_AGENT_SEARCH_FILES_ACTION",
    "CODE_AGENT_UPDATE_FILE_ACTION",
    "PatchWorkflowError",
    "acceptPatch",
    "createAcceptedPatchFileAction",
    "createCodeAgentCanonicalWorkspaceRoots",
    "createCodeAgentCommandActionCapability",
    "createCodeAgentFileActionCapability",
    "createPatchProposal",
    "defaultCodeAgentCommandLimits",
    "defaultCodeAgentFileLimits",
    "defaultPatchWorkflowLimits",
    "materializePatchReview",
    "rejectPatch",
    "resolveWorkspacePath",
  ],
  "@agent-anything/code-agent/workspace": ["resolveWorkspacePath"],
  "@agent-anything/code-agent/filesystem": [
    "CODE_AGENT_CREATE_FILE_ACTION",
    "CODE_AGENT_DELETE_FILE_ACTION",
    "CODE_AGENT_LIST_FILES_ACTION",
    "CODE_AGENT_READ_FILE_ACTION",
    "CODE_AGENT_SEARCH_FILES_ACTION",
    "CODE_AGENT_UPDATE_FILE_ACTION",
    "createAcceptedPatchFileAction",
    "createCodeAgentCanonicalWorkspaceRoots",
    "createCodeAgentFileActionCapability",
    "defaultCodeAgentFileLimits",
  ],
  "@agent-anything/code-agent/command": [
    "CODE_AGENT_RUN_COMMAND_ACTION",
    "createCodeAgentCommandActionCapability",
    "defaultCodeAgentCommandLimits",
  ],
  "@agent-anything/helarc": [
    "DEFAULT_HELARC_TASK_PROMPT_MAX_LENGTH",
    "HELARC_PRODUCT_ID",
    "HELARC_TASK_KIND",
    "HELARC_WORKSPACE_ROOT_NAME",
    "applyHelarcRunProgressCommit",
    "applyHelarcRunStartCommit",
    "applyHelarcRunTerminalCommit",
    "createBuiltInHelarcTaskTemplates",
    "createHelarcActionComposition",
    "createHelarcArtifact",
    "createHelarcConversation",
    "createHelarcMessage",
    "createHelarcPersistedRun",
    "createHelarcProductComposition",
    "createHelarcProductRunProjection",
    "createHelarcProviderProfile",
    "createHelarcRunInput",
    "createHelarcRunProjection",
    "createHelarcTask",
    "createHelarcTaskTemplate",
    "createHelarcThread",
    "createHelarcWorkspaceProfile",
    "createTrustedHelarcWorkspaceScope",
    "deriveHelarcPersistedRunStatus",
    "deriveHelarcRunDisplayProjection",
    "helarcProduct",
    "normalizeHelarcThreadAggregate",
    "normalizeHelarcThreadRecord",
    "reduceHelarcProductRunProjection",
    "reduceHelarcRunProjection",
    "renderHelarcTaskTemplatePrompt",
    "resolveHelarcPermissionPreset",
    "selectHelarcProviderProfile",
    "selectHelarcTaskTemplate",
    "selectHelarcWorkspaceProfile",
  ],
  "@agent-anything/code-agent/patch": [
    "PatchWorkflowError",
    "acceptPatch",
    "createPatchProposal",
    "defaultPatchWorkflowLimits",
    "materializePatchReview",
    "rejectPatch",
  ],
};

const expectedExtensionValueExports = {
  "@agent-anything/extensions": [
    "McpRegistry",
    "PluginRegistry",
    "PluginRegistryError",
    "createMcpActionCapability",
    "createRemoteActionCapability",
    "createRemoteToolActionCapability",
  ],
  "@agent-anything/extensions/remote-tools": ["createRemoteToolActionCapability"],
  "@agent-anything/extensions/remote-actions": ["createRemoteActionCapability"],
  "@agent-anything/extensions/mcp": ["McpRegistry", "createMcpActionCapability"],
  "@agent-anything/extensions/plugins": ["PluginRegistry", "PluginRegistryError"],
  "@agent-anything/extensions/enterprise-storage": [],
};

const removedOrPrivateSpecifiers = [
  "@agent-anything/agent-core/runner",
  "@agent-anything/agent-core/action-execution",
  "@agent-anything/agent-core/host",
  "@agent-anything/action-execution/ActionGovernanceAssessment",
  "@agent-anything/agent-runtime/runner",
  "@agent-anything/host/HostRuntime",
  "@agent-anything/code-agent/file-actions",
  "@agent-anything/code-agent/command-actions",
];

checkBuiltSurfaces(
  expectedLowerValueExports,
  [
    "@agent-anything/evidence/EvidenceRef",
    "@agent-anything/governance/policy/ActionPolicyPort",
    "@agent-anything/observability/redaction/Redactor",
    "@agent-anything/permission/approval/snapshot",
    "@agent-anything/providers/ProviderAttemptInterruption",
  ],
  join(repoRoot, "packages/agent-runtime"),
);
checkBuiltSurfaces(
  expectedValueExports,
  removedOrPrivateSpecifiers,
  join(repoRoot, "apps/helarc-desktop"),
);
checkBuiltSurfaces(
  expectedExtensionValueExports,
  [
    "@agent-anything/extensions/action-registrations",
    "@agent-anything/extensions/RemoteActionRegistration",
  ],
  join(repoRoot, "packages/extensions"),
);

console.log("Built public API check passed.");

function checkBuiltSurfaces(expected, unavailableSpecifiers, cwd) {
  const childSource = `
    import assert from "node:assert/strict";
    const expected = ${JSON.stringify(expected)};
    for (const [specifier, expectedKeys] of Object.entries(expected)) {
      const api = await import(specifier);
      assert.deepEqual(Object.keys(api).sort(), expectedKeys, specifier + " value exports changed");
    }
    for (const specifier of ${JSON.stringify(unavailableSpecifiers)}) {
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
    { cwd, encoding: "utf8" },
  );

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.stdout.write(result.stdout);
    process.exit(result.status ?? 1);
  }
}
