import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const packageExportKeys = {
  "harness/agent-core/contracts": [
    "./action",
    "./agent",
    "./input",
    "./run",
    "./task",
  ],
  "harness/context": [
    "./context",
    "./evidence",
    "./persistence",
  ],
  "harness/tools": [".", "./catalog", "./registration", "./selection"],
  "harness/safety/governance": [
    ".",
    "./amendment",
    "./managed-permission",
    "./policy",
  ],
  "harness/safety/permission": [".", "./approval", "./authority", "./profile"],
  "harness/observability": [
    ".",
    "./audit",
    "./events",
    "./redaction",
    "./telemetry",
    "./tracing",
  ],
  "harness/model-interaction": ["."],
  "tooling/test-support": ["."],
  "harness/safety/action-execution": [
    "./canonical",
    "./enforcement",
    "./execution",
    "./registration",
    "./sandbox",
  ],
  "harness/agent-core/runtime": [
    "./controller",
    "./plan",
    "./retry",
    "./run",
    "./runner",
  ],
  "harness/host": [
    "./authority",
    "./composition",
    "./context",
    "./projection",
    "./run",
    "./transport",
  ],
  "products/helarc/code-agent": [".", "./command", "./filesystem", "./patch", "./workspace"],
  "harness/integrations/remote": [".", "./action", "./tools"],
  "harness/integrations/mcp": ["."],
  "harness/integrations/plugins": ["."],
  "harness/integrations/enterprise-storage": [".", "./evidence"],
  "products/helarc/product": ["."],
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
  "@agent-anything/agent-core/action": [],
  "@agent-anything/agent-core/agent": ["snapshotAgent"],
  "@agent-anything/agent-core/input": ["snapshotRunInput"],
  "@agent-anything/agent-core/run": [
    "findRunWorkspace",
    "listRunWorkspaces",
    "snapshotIdentityRef",
    "snapshotRunWorkspace",
    "snapshotWorkspaceContext",
  ],
  "@agent-anything/agent-core/task": ["snapshotAgentTask"],
  "@agent-anything/context/context": [
    "ContextProjectionError",
    "applyContextUpdate",
    "createInitialContext",
    "snapshotContextProjection",
    "snapshotContextProjectionRequest",
  ],
  "@agent-anything/context/evidence": [
    "EvidenceBuilder",
    "classifyToolResult",
    "settleToolResultEvidence",
  ],
  "@agent-anything/context/persistence": [],
  "@agent-anything/tools": [
    "ToolCatalogValidationError",
    "ToolRegistrationValidationError",
    "ToolSelectionValidationError",
    "createToolCatalogSnapshot",
    "createToolRegistrationSnapshot",
    "createToolSelectionSnapshot",
    "createToolSourceRef",
    "findSelectedTool",
    "findToolDescriptor",
    "findToolRegistration",
  ],
  "@agent-anything/tools/catalog": [
    "ToolCatalogValidationError",
    "createToolCatalogSnapshot",
    "findToolDescriptor",
  ],
  "@agent-anything/tools/registration": [
    "ToolRegistrationValidationError",
    "createToolRegistrationSnapshot",
    "createToolSourceRef",
    "findToolRegistration",
  ],
  "@agent-anything/tools/selection": [
    "ToolSelectionValidationError",
    "createToolSelectionSnapshot",
    "findSelectedTool",
  ],
  "@agent-anything/governance": [
    "createAllowAllActionPolicyPort",
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
    "AUDIT_RECORD_SCHEMA_VERSION",
    "RUNTIME_EVENT_SCHEMA_VERSION",
    "RUN_TRACE_SCHEMA_VERSION",
    "Redactor",
    "RunTraceAssembler",
    "RuntimeEventStream",
    "TELEMETRY_RECORD_SCHEMA_VERSION",
    "createAuditRecord",
    "createControllerTurnTraceOperationId",
    "createTelemetryRecord",
    "defaultRedactionRules",
    "snapshotRuntimeEventPayload",
  ],
  "@agent-anything/observability/audit": [
    "AUDIT_RECORD_SCHEMA_VERSION",
    "createAuditRecord",
  ],
  "@agent-anything/observability/telemetry": [
    "TELEMETRY_RECORD_SCHEMA_VERSION",
    "createTelemetryRecord",
  ],
  "@agent-anything/observability/redaction": ["Redactor", "defaultRedactionRules"],
  "@agent-anything/observability/tracing": [
    "RUN_TRACE_SCHEMA_VERSION",
    "RunTraceAssembler",
    "createControllerTurnTraceOperationId",
  ],
  "@agent-anything/model-interaction": [
    "createProviderAttemptInterruption",
    "providerResultFromInterruption",
  ],
  "@agent-anything/test-support": [
    "FakeApprovalReviewer",
    "FakeAuditPort",
    "FakeEvidencePersistencePort",
    "FakeProvider",
    "FakeRuntimeEventPublisher",
    "FakeTelemetryPort",
    "createTestContextProjection",
    "createTestIdentityContextProjector",
  ],
};

const expectedValueExports = {
  "@agent-anything/observability/events": [
    "RUNTIME_EVENT_SCHEMA_VERSION",
    "RuntimeEventStream",
    "snapshotRuntimeEventPayload",
  ],
  "@agent-anything/agent-runtime/controller": [
    "ControllerError",
    "ProviderBackedController",
    "StructuredOutputError",
  ],
  "@agent-anything/agent-runtime/plan": [
    "abandonPlan",
    "applyPlanUpdate",
    "assertValidPlanLimits",
    "projectPlan",
  ],
  "@agent-anything/agent-runtime/retry": [
    "RetryExecutor",
    "createSystemRetryExecutor",
    "snapshotRetryEvent",
    "snapshotRetryOperation",
    "snapshotRetryPolicy",
    "systemRetryClock",
  ],
  "@agent-anything/agent-runtime/run": [
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
  ],
  "@agent-anything/agent-runtime/runner": [
    "Runner",
  ],
  "@agent-anything/action-execution/canonical": [
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
  ],
  "@agent-anything/action-execution/registration": [
    "ActionRegistrationValidationError",
    "ToolActionBindingValidationError",
    "assertToolActionBindingSnapshot",
    "createActionAdapterImplementationSnapshot",
    "createActionRegistrationSnapshot",
    "createEmptyToolActionBindingSnapshot",
    "createToolActionBindingSnapshot",
    "findActionRegistration",
    "findToolActionBinding",
  ],
  "@agent-anything/action-execution/enforcement": [
    "ActionEnforcementPipeline",
    "snapshotRunActionContext",
  ],
  "@agent-anything/action-execution/sandbox": [
    "createSandboxExecutionGateway",
  ],
  "@agent-anything/action-execution/execution": [
    "assertActionExecutorDispatchContext",
    "createActionExecutionFailure",
  ],
  "@agent-anything/host/context": [
    "HostContextResolutionError",
    "createStaticHostIdentityResolver",
    "createStaticHostWorkspaceResolver",
    "resolveHostRunContext",
  ],
  "@agent-anything/host/composition": [
    "resolveHostRunPermissionConfig",
  ],
  "@agent-anything/host/run": [
    "createHostRunManager",
  ],
  "@agent-anything/host/projection": [
    "HOST_RETRY_EVENT_LIMIT",
    "createHostRunProjection",
    "createHostRunProjectionStore",
    "createHostTerminalRunProjection",
    "projectRuntimeEventForHost",
    "reduceHostRunProjection",
    "snapshotHostCancellation",
  ],
  "@agent-anything/host/transport": [
    "HOST_COMMAND_REASON_MAX_LENGTH",
    "HOST_COMMAND_RECEIPT_LIMIT",
    "HOST_COMMAND_VERSION",
    "createHostCommandDispatcher",
    "snapshotHostCommand",
  ],
  "@agent-anything/host/authority": [
    "createInMemoryHostPolicyAmendmentStore",
    "createInMemoryHostSessionAuthorityStore",
    "createUserApprovalReviewBridge",
  ],
  "@agent-anything/helarc-code-agent": [
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
  "@agent-anything/helarc-code-agent/workspace": ["resolveWorkspacePath"],
  "@agent-anything/helarc-code-agent/filesystem": [
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
  "@agent-anything/helarc-code-agent/command": [
    "CODE_AGENT_RUN_COMMAND_ACTION",
    "createCodeAgentCommandActionCapability",
    "defaultCodeAgentCommandLimits",
  ],
  "@agent-anything/helarc": [
    "DEFAULT_HELARC_TASK_PROMPT_MAX_LENGTH",
    "HELARC_PRODUCT_ID",
    "HELARC_TASK_KIND",
    "applyHelarcRunProgressCommit",
    "applyHelarcRunStartCommit",
    "applyHelarcRunTerminalCommit",
    "createBuiltInHelarcTaskTemplates",
    "createHelarcActionComposition",
    "createHelarcArtifact",
    "createHelarcContextProjector",
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
    "deriveHelarcPersistedRunStatus",
    "deriveHelarcRunDisplayProjection",
    "helarcProduct",
    "normalizeHelarcThreadAggregate",
    "normalizeHelarcThreadRecord",
    "projectHelarcRunWorkspaceContext",
    "reduceHelarcProductRunProjection",
    "reduceHelarcRunProjection",
    "renderHelarcTaskTemplatePrompt",
    "resolveHelarcPermissionPreset",
    "selectHelarcProviderProfile",
    "selectHelarcTaskTemplate",
    "selectHelarcWorkspaceProfile",
  ],
  "@agent-anything/helarc-code-agent/patch": [
    "PatchWorkflowError",
    "acceptPatch",
    "createPatchProposal",
    "defaultPatchWorkflowLimits",
    "materializePatchReview",
    "rejectPatch",
  ],
};

const expectedRemoteIntegrationValueExports = {
  "@agent-anything/remote-integrations": [
    "createRemoteActionCapability",
    "createRemoteToolActionCapability",
  ],
  "@agent-anything/remote-integrations/action": ["createRemoteActionCapability"],
  "@agent-anything/remote-integrations/tools": ["createRemoteToolActionCapability"],
};

const expectedMcpValueExports = {
  "@agent-anything/mcp": [
    "MCP_PROTOCOL_REVISION",
    "McpActivationError",
    "McpOperationError",
    "McpPrimitiveError",
    "McpProtocolError",
    "McpRegistrationError",
    "McpRegistry",
    "createMcpActionCapability",
    "createMcpServerRegistration",
  ],
};

const expectedPluginValueExports = {
  "@agent-anything/plugins": [
    "PluginActivationContractError",
    "PluginAdmissionValidationError",
    "PluginManifestValidationError",
    "PluginRegistry",
    "PluginRegistryError",
    "createPluginAdmissionSnapshot",
    "createPluginContributionSourceRef",
    "createPluginManifestSnapshot",
    "createPluginOwnerActivationRequest",
    "createPluginOwnerDeactivationRequest",
    "findPluginContributionAdmission",
    "settlePluginOwnerActivationResult",
    "settlePluginOwnerDeactivationResult",
    "snapshotPluginManifestEnvironment",
    "validatePluginManifest",
  ],
};

const expectedEnterpriseStorageValueExports = {
  "@agent-anything/enterprise-storage": [
    "EnterpriseEvidencePersistenceAdapter",
    "createEnterpriseEvidencePersistenceAdapter",
  ],
  "@agent-anything/enterprise-storage/evidence": [
    "EnterpriseEvidencePersistenceAdapter",
    "createEnterpriseEvidencePersistenceAdapter",
  ],
};

const removedOrPrivateSpecifiers = [
  "@agent-anything/foundation",
  "@agent-anything/runtime",
  "@agent-anything/agent-core/error",
  "@agent-anything/agent-core/result",
  "@agent-anything/testing",
  "@agent-anything/agent-runtime",
  "@agent-anything/providers",
  "@agent-anything/evidence",
  "@agent-anything/storage",
  "@agent-anything/agent-core",
  "@agent-anything/agent-core/artifact",
  "@agent-anything/agent-core/interaction",
  "@agent-anything/agent-core/invocation",
  "@agent-anything/agent-core/primitives",
  "@agent-anything/agent-core/workspace",
  "@agent-anything/agent-core/events",
  "@agent-anything/agent-core/context",
  "@agent-anything/agent-core/controller",
  "@agent-anything/agent-core/plan",
  "@agent-anything/agent-core/retry",
  "@agent-anything/agent-core/action-execution",
  "@agent-anything/agent-core/host",
  "@agent-anything/action-execution",
  "@agent-anything/action-execution/ActionGovernanceAssessment",
  "@agent-anything/host",
  "@agent-anything/host/HostRuntime",
  "@agent-anything/governance/identity",
  "@agent-anything/governance/workspace",
  "@agent-anything/helarc-code-agent/file-actions",
  "@agent-anything/helarc-code-agent/command-actions",
];

checkBuiltSurfaces(
  expectedLowerValueExports,
  [
    "@agent-anything/shared",
    "@agent-anything/evidence/EvidenceRef",
    "@agent-anything/governance/policy/ActionPolicyPort",
    "@agent-anything/observability/redaction/Redactor",
    "@agent-anything/permission/approval/snapshot",
    "@agent-anything/model-interaction/ProviderAttemptInterruption",
    "@agent-anything/context",
    "@agent-anything/context/observation",
  ],
  join(repoRoot, "harness/agent-core/runtime"),
);
checkBuiltSurfaces(
  expectedValueExports,
  removedOrPrivateSpecifiers,
  join(repoRoot, "products/helarc/desktop"),
);
checkBuiltSurfaces(
  expectedRemoteIntegrationValueExports,
  [
    "@agent-anything/extensions",
    "@agent-anything/extensions/action-registrations",
    "@agent-anything/extensions/enterprise-storage",
    "@agent-anything/extensions/mcp",
    "@agent-anything/extensions/plugins",
    "@agent-anything/extensions/remote-actions",
    "@agent-anything/extensions/remote-tools",
  ],
  join(repoRoot, "harness/integrations/remote"),
);
checkBuiltSurfaces(
  expectedMcpValueExports,
  [
    "@agent-anything/mcp/McpConnectionPort",
    "@agent-anything/mcp/McpServerRegistration",
    "@agent-anything/mcp/McpToolOperationPort",
    "@agent-anything/mcp/McpToolRegistration",
  ],
  join(repoRoot, "harness/integrations/mcp"),
);
checkBuiltSurfaces(
  expectedPluginValueExports,
  [],
  join(repoRoot, "harness/integrations/plugins"),
);
checkBuiltSurfaces(
  expectedEnterpriseStorageValueExports,
  [
    "@agent-anything/enterprise-storage/EnterpriseStoragePort",
  ],
  join(repoRoot, "harness/integrations/enterprise-storage"),
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
