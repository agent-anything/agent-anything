import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const packageExportKeys = {
  "harness/workspace": ["./identity", "./selection"],
  "harness/agent-core/contracts": [
    "./agent",
    "./control",
    "./input",
    "./run",
    "./run-action",
    "./run-item",
    "./task",
  ],
  "harness/operation-catalog": ["./binding", "./catalog", "./identity", "./result"],
  "harness/interaction": ["./coordination", "./protocol", "./records"],
  "harness/safety/canonical-action": [
    "./assessment",
    "./lifecycle",
    "./registration",
    "./settlement",
    "./subject",
  ],
  "harness/context": [
    "./context",
    "./evidence",
    "./persistence",
  ],
  "harness/tools": [
    "./activation",
    "./catalog",
    "./identity",
    "./invocation",
    "./registration",
    "./result",
    "./selection",
  ],
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
  "harness/evaluation": [
    "./campaign",
    "./capture",
    "./definition",
    "./grading",
    "./metrics",
    "./persistence",
    "./report",
    "./trial",
  ],
  "harness/model-interaction": ["."],
  "tooling/test-support": [".", "./evaluation-targets/helarc"],
  "harness/safety/action-execution": [
    "./coordination",
    "./enforcement",
    "./execution",
    "./registration",
    "./sandbox",
  ],
  "harness/operation-composition": ["./definition", "./execution", "./result"],
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
  "products/helarc/code-agent": [
    "./file-operation",
    "./source",
    "./workspace",
  ],
  "products/helarc/core": [
    ".",
    "./agent",
    "./artifacts",
    "./composition",
    "./configuration",
    "./controller",
    "./observability",
    "./prompt",
    "./result",
    "./review",
    "./run",
    "./task",
    "./thread",
    "./tools",
    "./work-context",
  ],
  "products/helarc/local-environment": [
    "./command",
    "./filesystem",
    "./sandbox",
    "./workspace",
  ],
  "harness/integrations/remote": ["./action", "./tools"],
  "harness/integrations/mcp": [
    "./adapters",
    "./lifecycle",
    "./primitives",
    "./protocol",
    "./registration",
    "./transport",
  ],
  "harness/integrations/plugins": [
    "./activation",
    "./admission",
    "./lifecycle",
    "./manifest",
  ],
  "harness/integrations/enterprise-storage": ["./evidence"],
};

for (const [packagePath, expectedKeys] of Object.entries(packageExportKeys)) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, packagePath, "package.json"), "utf8"));
  assert.deepEqual(
    Object.keys(manifest.exports ?? {}).sort(),
    expectedKeys,
    `${manifest.name} export keys changed without updating the public API contract`,
  );
}

const removedGeneratedPaths = [
  "harness/agent-core/contracts/dist/action",
  "harness/agent-core/contracts/dist/run/InvocationInterruption.js",
  "harness/agent-core/contracts/dist/run/Workspace.js",
  "harness/context/dist/index.js",
  "harness/context/dist/observation",
  "harness/host/dist/index.js",
  "harness/host/dist/HostRuntime.js",
  "harness/integrations/enterprise-storage/dist/index.js",
  "harness/integrations/mcp/dist/index.js",
  "harness/integrations/plugins/dist/index.js",
  "harness/integrations/remote/dist/index.js",
  "harness/safety/action-execution/dist/index.js",
  "harness/safety/action-execution/dist/canonical",
  "harness/safety/action-execution/dist/preparation",
  "harness/tools/dist/index.js",
  "products/helarc/code-agent/dist/index.js",
  "products/helarc/code-agent/dist/command-actions",
  "products/helarc/code-agent/dist/process",
  "products/helarc/code-agent/dist/command",
  "products/helarc/code-agent/dist/controller",
  "products/helarc/code-agent/dist/file-actions",
  "products/helarc/code-agent/dist/filesystem",
  "products/helarc/code-agent/dist/observability",
  "products/helarc/code-agent/dist/patch",
  "products/helarc/code-agent/dist/prompt",
  "products/helarc/code-agent/dist/task",
  "products/helarc/code-agent/dist/task-templates",
  "products/helarc/code-agent/dist/tools",
  "products/helarc/product",
];

for (const removedPath of removedGeneratedPaths) {
  assert.equal(
    existsSync(join(repoRoot, removedPath)),
    false,
    `removed generated output remains: ${removedPath}`,
  );
}

const expectedLowerValueExports = {
  "@agent-anything/workspace/identity": ["snapshotWorkspaceIdentity"],
  "@agent-anything/workspace/selection": [
    "findSelectedWorkspace",
    "listSelectedWorkspaces",
    "snapshotWorkspaceSelection",
  ],
  "@agent-anything/agent-core/agent": ["snapshotAgent", "toAgentRevisionRef"],
  "@agent-anything/agent-core/control": [],
  "@agent-anything/agent-core/input": ["snapshotRunInput"],
  "@agent-anything/agent-core/run": ["snapshotIdentityRef"],
  "@agent-anything/agent-core/run-action": [],
  "@agent-anything/agent-core/run-item": [],
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
    "settleEvidenceContribution",
    "snapshotEvidenceContribution",
  ],
  "@agent-anything/context/persistence": [],
  "@agent-anything/tools/identity": [
    "createToolContractIdentity",
    "toolRevisionKey",
  ],
  "@agent-anything/tools/catalog": [
    "ToolCatalogValidationError",
    "createToolCatalogSnapshot",
    "findToolDescriptor",
  ],
  "@agent-anything/tools/registration": [
    "ToolRegistrationValidationError",
    "createToolRegistrationSnapshot",
    "findToolRegistration",
  ],
  "@agent-anything/tools/selection": [
    "ToolSelectionValidationError",
    "createControllerToolExposureProof",
    "createFixedLocalToolSelection",
    "findSelectedTool",
    "snapshotToolSelectionRevision",
  ],
  "@agent-anything/tools/invocation": [
    "materializeToolCall",
    "validateExactToolCall",
  ],
  "@agent-anything/tools/result": ["adaptToolSemanticResult"],
  "@agent-anything/tools/activation": [],
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
    "APPROVAL_INTERACTION_PROTOCOL",
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
    "createActionPermissionAssessmentPort",
    "createApprovalInteractionPresentation",
    "createApprovalInteractionProtocol",
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
    "sealApprovalRequirement",
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
    "APPROVAL_INTERACTION_PROTOCOL",
    "ApprovalContractError",
    "allowsActionApproval",
    "canonicalizeAdditionalPermissions",
    "createApprovalInteractionPresentation",
    "createApprovalInteractionProtocol",
    "createApprovalRequest",
    "projectApprovalReviewRequest",
    "sealApprovalRequirement",
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
    "createActionPermissionAssessmentPort",
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
  "@agent-anything/test-support/evaluation-targets/helarc": [
    "HELARC_EVALUATION_CORPUS_REVISION",
    "HELARC_EVALUATION_TARGET_ADAPTER_REVISION",
    "HELARC_EVALUATION_TIME",
    "HELARC_PHASE26_ACCEPTED_BASELINE",
    "adaptHelarcExternalBenchmarkManifest",
    "compareHelarcEvaluationBaseline",
    "createHelarcEvaluationCorpus",
    "createHelarcEvaluationTargetAdapter",
    "projectHelarcEvaluationBaselineSignature",
    "runHelarcEvaluationBaselineCandidate",
  ],
};

const expectedOperationCatalogValueExports = {
  "@agent-anything/operation-catalog/identity": [
    "operationRevisionKey",
    "snapshotOperationBindingRevisionRef",
    "snapshotOperationCorrelation",
    "snapshotOperationInvocationRef",
    "snapshotOperationKey",
    "snapshotOperationRevisionRef",
  ],
  "@agent-anything/operation-catalog/catalog": [
    "OperationContractValidationError",
    "createOperationCatalogSnapshot",
    "findRegisteredOperation",
  ],
  "@agent-anything/operation-catalog/binding": [
    "createOperationBindingResolverSnapshot",
    "snapshotResolvedOperationBinding",
    "unavailableOperationBindingResolver",
  ],
  "@agent-anything/operation-catalog/result": ["createOperationResult"],
};

const expectedInteractionValueExports = {
  "@agent-anything/interaction/protocol": [
    "snapshotInteractionProtocolRef",
    "snapshotInteractionRequest",
    "snapshotInteractionRequestRef",
    "snapshotInteractionSubjectRef",
    "snapshotSafeInteractionEnvelope",
  ],
  "@agent-anything/interaction/coordination": [
    "InteractionContractError",
    "InteractionExecution",
    "createInteractionProtocolRegistrySnapshot",
    "snapshotPendingInteractionRef",
  ],
  "@agent-anything/interaction/records": [
    "snapshotInteractionApplicationRef",
    "snapshotInteractionResolutionRef",
    "snapshotInteractionSubmissionRecordRef",
    "snapshotInteractionTerminalRecord",
    "snapshotInteractionTransportReceipt",
  ],
};

const expectedOperationCompositionValueExports = {
  "@agent-anything/operation-composition/definition": [
    "snapshotCompositeDefinition",
  ],
  "@agent-anything/operation-composition/execution": ["CompositeExecution"],
  "@agent-anything/operation-composition/result": [],
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
    "validateControllerDecision",
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
    "toRunCancellationSummary",
  ],
  "@agent-anything/agent-runtime/runner": [
    "Runner",
  ],
  "@agent-anything/canonical-action/subject": [
    "ActionContractValidationError",
    "CANONICAL_ACTION_SUBJECT_FINGERPRINT_DOMAIN",
    "CanonicalEncodingError",
    "PreparedActionInvocationValidationError",
    "addCapabilityEffect",
    "assertPreparedInvocationMatchesExecutor",
    "canonicalEncode",
    "canonicalEndpointKey",
    "canonicalPathIdentityKey",
    "canonicalPathTargetKey",
    "canonicalRemoteToolKey",
    "canonicalRemoteToolTargetKey",
    "capabilityEffectKey",
    "createActionEffectSet",
    "createCanonicalActionSubjectFingerprint",
    "createCanonicalActorIdentity",
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
    "createSafeActionSummary",
    "createTargetStateAssertions",
    "mergeTargetStateAssertions",
    "snapshotCapabilityEffect",
    "targetStateAssertionKey",
  ],
  "@agent-anything/canonical-action/assessment": [],
  "@agent-anything/canonical-action/lifecycle": [],
  "@agent-anything/canonical-action/settlement": [],
  "@agent-anything/canonical-action/registration": [
    "ActionRegistrationValidationError",
    "createActionRegistrationSnapshot",
    "findActionRegistrationByAdapter",
    "findActionRegistrationByBinding",
  ],
  "@agent-anything/action-execution/registration": [
    "createActionAdapterImplementationSnapshot",
    "createPreparedAction",
  ],
  "@agent-anything/action-execution/coordination": [
    "CanonicalActionCommitError",
    "CanonicalActionLedger",
  ],
  "@agent-anything/action-execution/enforcement": [
    "ActionExecutionCoordinator",
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
    "HOST_INTERACTION_PAYLOAD_MAX_BYTES",
    "createHostCommandDispatcher",
    "snapshotHostCommand",
  ],
  "@agent-anything/host/authority": [
    "createInMemoryHostPolicyAmendmentStore",
    "createInMemoryHostSessionAuthorityStore",
  ],
  "@agent-anything/helarc-code-agent/workspace": ["resolveWorkspacePath"],
  "@agent-anything/helarc-code-agent/source": [],
  "@agent-anything/helarc-code-agent/file-operation": [
    "CODE_AGENT_CREATE_FILE_TOOL",
    "CODE_AGENT_DELETE_FILE_TOOL",
    "CODE_AGENT_LIST_FILES_TOOL",
    "CODE_AGENT_READ_FILE_TOOL",
    "CODE_AGENT_SEARCH_FILES_TOOL",
    "CODE_AGENT_UPDATE_FILE_TOOL",
    "bindingRefForCodeFileTool",
    "codeFileOperationForRef",
    "createCodeFileOperationContribution",
    "operationRefForCodeFileTool",
  ],
  "@agent-anything/helarc": [
    "HELARC_PRODUCT_ID",
    "helarcProduct",
  ],
  "@agent-anything/helarc/agent": ["createHelarcAgent"],
  "@agent-anything/helarc/task": [
    "DEFAULT_HELARC_TASK_PROMPT_MAX_LENGTH",
    "HELARC_TASK_KIND",
    "createBuiltInHelarcTaskTemplates",
    "createHelarcTask",
    "createHelarcTaskTemplate",
    "renderHelarcTaskTemplatePrompt",
    "selectHelarcTaskTemplate",
  ],
  "@agent-anything/helarc/controller": [
    "HELARC_CONTROLLER_ACTIONS",
    "HELARC_CONTROLLER_CAPABILITY",
    "HELARC_CONTROLLER_OUTPUT_MAX_LENGTH",
    "HELARC_PERMISSION_REQUEST_PROTOCOL",
    "HelarcControllerParseError",
    "buildHelarcActionDecisionRulesText",
    "buildHelarcActionProtocolText",
    "buildHelarcProviderRequest",
    "createHelarcActionContract",
    "createHelarcContextProjector",
    "parseHelarcProviderResponse",
    "parseStructuredOutput",
  ],
  "@agent-anything/helarc/prompt": [
    "HELARC_ACTION_CONTRACT_VERSION",
    "HELARC_PROMPT_ARCHITECTURE_VERSION",
    "HELARC_TOOL_CATALOG_VERSION",
    "buildHelarcPromptAssembly",
  ],
  "@agent-anything/helarc/tools": [
    "HELARC_RUN_COMMAND_BINDING",
    "HELARC_RUN_COMMAND_OPERATION",
    "HELARC_RUN_COMMAND_TOOL",
    "HELARC_TOOL_CATALOG_METADATA_KEY",
    "buildHelarcToolCatalogText",
    "createDefaultHelarcToolCatalog",
    "createHelarcCommandOperationContribution",
    "createHelarcToolCatalogFromDescriptors",
    "createHelarcToolCatalogMetadata",
    "readHelarcToolCatalog",
  ],
  "@agent-anything/helarc/configuration": [
    "createHelarcProviderProfile",
    "createHelarcWorkspaceProfile",
    "resolveHelarcPermissionPreset",
    "selectHelarcProviderProfile",
    "selectHelarcWorkspaceProfile",
  ],
  "@agent-anything/helarc/work-context": [
    "applyHelarcRunProgressCommit",
    "applyHelarcRunStartCommit",
    "applyHelarcRunTerminalCommit",
    "createHelarcArtifact",
    "createHelarcMessage",
    "createHelarcPersistedRun",
    "createHelarcThread",
    "deriveHelarcPersistedRunStatus",
    "normalizeHelarcThreadAggregate",
    "normalizeHelarcThreadRecord",
    "projectHelarcWorkspaceSelectionIdentity",
    "snapshotHelarcCollaborationRecord",
    "snapshotHelarcReviewRecord",
  ],
  "@agent-anything/helarc/thread": [
    "createHelarcMessage",
    "createHelarcPersistedRun",
    "createHelarcThread",
    "deriveHelarcPersistedRunStatus",
    "normalizeHelarcThreadRecord",
    "projectHelarcWorkspaceSelectionIdentity",
  ],
  "@agent-anything/helarc/run": [
    "createHelarcProductRunProjection",
    "createHelarcRunInput",
    "createHelarcRunProjection",
    "deriveHelarcRunDisplayProjection",
    "reduceHelarcProductRunProjection",
    "reduceHelarcRunProjection",
  ],
  "@agent-anything/helarc/composition": [
    "createHelarcActionComposition",
    "createHelarcProductComposition",
    "mapRuntimeEventToHelarcActivity",
    "projectHelarcProductResult",
    "validateHelarcToolInput",
  ],
  "@agent-anything/helarc/review": [
    "HelarcPatchActionController",
    "PatchWorkflowError",
    "acceptPatch",
    "createPatchProposal",
    "defaultPatchWorkflowLimits",
    "materializePatchReview",
    "rejectPatch",
    "requestPatchRevision",
  ],
  "@agent-anything/helarc/observability": [
    "HelarcTracingController",
    "projectHelarcControllerTraceForEvent",
  ],
  "@agent-anything/helarc/result": [
    "mapRuntimeEventToHelarcActivity",
    "projectHelarcProductResult",
  ],
  "@agent-anything/helarc/artifacts": ["createHelarcArtifact"],
  "@agent-anything/helarc-local-environment/command": [
    "HELARC_LOCAL_COMMAND_ACTION_ADAPTER_ID",
    "createHelarcLocalCommandActionCapability",
    "defaultCodeAgentCommandLimits",
  ],
  "@agent-anything/helarc-local-environment/filesystem": [
    "HELARC_LOCAL_FILE_ACTION_ADAPTER_IDS",
    "createCodeAgentCanonicalWorkspaceRoots",
    "createHelarcLocalFileActionCapability",
    "createLocalCodeSourcePort",
    "defaultCodeAgentFileLimits",
    "inspectPreparedFileSystemTarget",
    "prepareFileSystemTarget",
  ],
  "@agent-anything/helarc-local-environment/sandbox": [
    "createHelarcLocalSandboxGateway",
  ],
  "@agent-anything/helarc-local-environment/workspace": [
    "createCodeAgentCanonicalWorkspaceRoots",
  ],
};

const expectedEvaluationValueExports = {
  "@agent-anything/evaluation/definition": [
    "EvaluationContractError",
    "createEvaluationCase",
    "createEvaluationFailure",
    "createEvaluationObjective",
    "createEvaluationRecordRef",
    "createEvaluationSchemaRef",
    "createEvaluationSuite",
    "createEvaluationTargetSnapshot",
    "isEvaluationRefEqual",
    "snapshotEvaluationData",
  ],
  "@agent-anything/evaluation/campaign": [
    "EvaluationCampaignExecution",
    "createEvaluationCampaign",
    "createInitialEvaluationCampaignSnapshot",
    "planEvaluationTrials",
  ],
  "@agent-anything/evaluation/trial": [
    "EvaluationTrialExecution",
    "createEvaluationTargetObservation",
    "createEvaluationTrial",
    "createInitialEvaluationTrialSnapshot",
    "isEvaluationTrialTerminal",
    "projectEvaluationTrial",
  ],
  "@agent-anything/evaluation/capture": [
    "assembleEvaluationCapture",
    "createEvaluationCapturePolicy",
    "projectEvaluationCapture",
  ],
  "@agent-anything/evaluation/grading": [
    "DeterministicEvaluationGrader",
    "EvaluationGradingExecution",
    "ReferenceEvaluationGrader",
    "createEvaluationCriterion",
    "createEvaluationGrade",
    "createEvaluationGraderDefinition",
  ],
  "@agent-anything/evaluation/metrics": [
    "aggregateEvaluationMetric",
    "comparePairedEvaluationSamples",
    "createEvaluationMetricDefinition",
    "evaluateEvaluationMetricGate",
  ],
  "@agent-anything/evaluation/report": [
    "createEvaluationBaselineAcceptance",
    "createEvaluationReport",
    "projectEvaluationReportForPublication",
  ],
  "@agent-anything/evaluation/persistence": [
    "EvaluationPersistenceError",
    "appendEvaluationRecord",
    "commitEvaluationSnapshot",
    "createEvaluationQueryProjection",
  ],
};

const expectedRemoteIntegrationValueExports = {
  "@agent-anything/remote-integrations/action": ["createRemoteActionCapability"],
  "@agent-anything/remote-integrations/tools": ["createRemoteToolActionCapability"],
};

const expectedMcpValueExports = {
  "@agent-anything/mcp/adapters": [
    "createMcpActionCapability",
  ],
  "@agent-anything/mcp/lifecycle": [
    "McpActivationError",
    "McpRegistry",
  ],
  "@agent-anything/mcp/primitives": [
    "McpPrimitiveError",
  ],
  "@agent-anything/mcp/protocol": [
    "McpOperationError",
    "McpProtocolError",
  ],
  "@agent-anything/mcp/registration": [
    "MCP_PROTOCOL_REVISION",
    "McpRegistrationError",
    "createMcpServerRegistration",
  ],
  "@agent-anything/mcp/transport": [],
};

const expectedPluginValueExports = {
  "@agent-anything/plugins/activation": [
    "PluginActivationContractError",
    "createPluginContributionSourceRef",
    "createPluginOwnerActivationRequest",
    "createPluginOwnerDeactivationRequest",
    "settlePluginOwnerActivationResult",
    "settlePluginOwnerDeactivationResult",
  ],
  "@agent-anything/plugins/admission": [
    "PluginAdmissionValidationError",
    "createPluginAdmissionSnapshot",
    "findPluginContributionAdmission",
  ],
  "@agent-anything/plugins/lifecycle": [
    "PluginRegistry",
    "PluginRegistryError",
  ],
  "@agent-anything/plugins/manifest": [
    "PluginManifestValidationError",
    "createPluginManifestSnapshot",
    "snapshotPluginManifestEnvironment",
    "validatePluginManifest",
  ],
};

const expectedEnterpriseStorageValueExports = {
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
  "@agent-anything/agent-core/action",
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
  "@agent-anything/action-execution/canonical",
  "@agent-anything/action-execution/preparation",
  "@agent-anything/canonical-action",
  "@agent-anything/interaction",
  "@agent-anything/operation-catalog",
  "@agent-anything/operation-composition",
  "@agent-anything/tools",
  "@agent-anything/workspace",
  "@agent-anything/host",
  "@agent-anything/host/HostRuntime",
  "@agent-anything/governance/identity",
  "@agent-anything/governance/workspace",
  "@agent-anything/helarc-code-agent",
  "@agent-anything/helarc-code-agent/command",
  "@agent-anything/helarc-code-agent/command-actions",
  "@agent-anything/helarc-code-agent/controller",
  "@agent-anything/helarc-code-agent/file-actions",
  "@agent-anything/helarc-code-agent/filesystem",
  "@agent-anything/helarc-code-agent/observability",
  "@agent-anything/helarc-code-agent/patch",
  "@agent-anything/helarc-code-agent/process",
  "@agent-anything/helarc-code-agent/prompt",
  "@agent-anything/helarc-code-agent/task",
  "@agent-anything/helarc-code-agent/task-templates",
  "@agent-anything/helarc-code-agent/tools",
  "@agent-anything/helarc-local-environment",
];

if (process.argv.includes("--helarc-evaluation-target-only")) {
  const specifier = "@agent-anything/test-support/evaluation-targets/helarc";
  checkBuiltSurfaces(
    { [specifier]: expectedValueExports[specifier] },
    [`${specifier}/internal`],
    join(repoRoot, "tooling/test-support"),
  );
  console.log("Built Helarc Evaluation target public API check passed.");
  process.exit(0);
}

if (process.argv.includes("--evaluation-only")) {
  checkBuiltSurfaces(
    expectedEvaluationValueExports,
    [
      "@agent-anything/evaluation",
      "@agent-anything/evaluation/internal",
    ],
    join(repoRoot, "harness/evaluation"),
  );
  console.log("Built Evaluation public API check passed.");
  process.exit(0);
}

if (process.argv.includes("--harness-execution-only")) {
  checkBuiltSurfaces(
    Object.fromEntries(
      Object.entries(expectedLowerValueExports).filter(
        ([specifier]) => specifier !== "@agent-anything/test-support/evaluation-targets/helarc",
      ),
    ),
    [
      "@agent-anything/context",
      "@agent-anything/context/observation",
      "@agent-anything/tools",
    ],
    join(repoRoot, "harness/agent-core/runtime"),
  );
  checkBuiltSurfaces(
    expectedOperationCatalogValueExports,
    ["@agent-anything/operation-catalog", "@agent-anything/operation-catalog/internal"],
    join(repoRoot, "harness/operation-catalog"),
  );
  checkBuiltSurfaces(
    expectedInteractionValueExports,
    ["@agent-anything/interaction", "@agent-anything/interaction/internal"],
    join(repoRoot, "harness/interaction"),
  );
  checkBuiltSurfaces(
    expectedOperationCompositionValueExports,
    ["@agent-anything/operation-composition", "@agent-anything/operation-composition/internal"],
    join(repoRoot, "harness/operation-composition"),
  );
  checkBuiltSurfaces(
    selectExpectedExports(expectedValueExports, [
      "@agent-anything/agent-runtime/",
      "@agent-anything/canonical-action/",
      "@agent-anything/action-execution/",
    ]),
    [
      "@agent-anything/action-execution",
      "@agent-anything/action-execution/canonical",
      "@agent-anything/action-execution/preparation",
      "@agent-anything/canonical-action",
    ],
    join(repoRoot, "harness/agent-core/runtime"),
  );
  checkBuiltSurfaces(
    selectExpectedExports(expectedValueExports, ["@agent-anything/host/"]),
    ["@agent-anything/host", "@agent-anything/host/HostRuntime"],
    join(repoRoot, "harness/host"),
  );
  console.log("Built Harness execution public API check passed.");
  process.exit(0);
}

if (process.argv.includes("--helarc-domain-only")) {
  checkBuiltSurfaces(
    {
      "@agent-anything/helarc": expectedValueExports["@agent-anything/helarc"],
      ...selectExpectedExports(expectedValueExports, [
        "@agent-anything/helarc/",
        "@agent-anything/helarc-code-agent/",
      ]),
    },
    removedOrPrivateSpecifiers.filter((specifier) =>
      specifier === "@agent-anything/helarc-code-agent" ||
      specifier.startsWith("@agent-anything/helarc-code-agent/")
    ),
    join(repoRoot, "products/helarc/core"),
  );
  checkBuiltSurfaces(
    selectExpectedExports(expectedValueExports, ["@agent-anything/helarc-code-agent/"]),
    removedOrPrivateSpecifiers.filter((specifier) =>
      specifier === "@agent-anything/helarc-code-agent" ||
      specifier.startsWith("@agent-anything/helarc-code-agent/")
    ),
    join(repoRoot, "products/helarc/code-agent"),
  );
  checkBuiltSurfaces(
    selectExpectedExports(expectedValueExports, ["@agent-anything/helarc-local-environment/"]),
    ["@agent-anything/helarc-local-environment"],
    join(repoRoot, "products/helarc/local-environment"),
  );
  console.log("Built Helarc domain public API check passed.");
  process.exit(0);
}

if (process.argv.includes("--helarc-only")) {
  checkBuiltSurfaces(
    expectedValueExports,
    removedOrPrivateSpecifiers,
    join(repoRoot, "products/helarc/desktop"),
  );
  console.log("Built Helarc public API check passed.");
  process.exit(0);
}

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
  expectedOperationCatalogValueExports,
  [
    "@agent-anything/operation-catalog",
    "@agent-anything/operation-catalog/internal",
  ],
  join(repoRoot, "harness/operation-catalog"),
);
checkBuiltSurfaces(
  expectedInteractionValueExports,
  [
    "@agent-anything/interaction",
    "@agent-anything/interaction/internal",
  ],
  join(repoRoot, "harness/interaction"),
);
checkBuiltSurfaces(
  expectedOperationCompositionValueExports,
  [
    "@agent-anything/operation-composition",
    "@agent-anything/operation-composition/internal",
  ],
  join(repoRoot, "harness/operation-composition"),
);
checkBuiltSurfaces(
  expectedEvaluationValueExports,
  [
    "@agent-anything/evaluation",
    "@agent-anything/evaluation/internal",
  ],
  join(repoRoot, "harness/evaluation"),
);
checkBuiltSurfaces(
  expectedValueExports,
  removedOrPrivateSpecifiers,
  join(repoRoot, "products/helarc/desktop"),
);
checkBuiltSurfaces(
  expectedRemoteIntegrationValueExports,
  [
    "@agent-anything/remote-integrations",
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
    "@agent-anything/mcp",
    "@agent-anything/mcp/McpConnectionPort",
    "@agent-anything/mcp/McpServerRegistration",
    "@agent-anything/mcp/McpToolOperationPort",
    "@agent-anything/mcp/McpToolRegistration",
    "@agent-anything/mcp/lifecycle/McpRegistry",
    "@agent-anything/mcp/primitives/McpPrimitiveCoordinator",
    "@agent-anything/mcp/protocol/McpPrimitiveProtocol",
    "@agent-anything/mcp/transport/McpTransportOperations",
  ],
  join(repoRoot, "harness/integrations/mcp"),
);
checkBuiltSurfaces(
  expectedPluginValueExports,
  [
    "@agent-anything/plugins",
    "@agent-anything/plugins/PluginActivation",
    "@agent-anything/plugins/PluginAdmission",
    "@agent-anything/plugins/PluginData",
    "@agent-anything/plugins/PluginManifest",
    "@agent-anything/plugins/PluginRegistry",
  ],
  join(repoRoot, "harness/integrations/plugins"),
);
checkBuiltSurfaces(
  expectedEnterpriseStorageValueExports,
  [
    "@agent-anything/enterprise-storage",
    "@agent-anything/enterprise-storage/EnterpriseStoragePort",
  ],
  join(repoRoot, "harness/integrations/enterprise-storage"),
);

console.log("Built public API check passed.");

function selectExpectedExports(expected, prefixes) {
  return Object.fromEntries(
    Object.entries(expected).filter(([specifier]) =>
      prefixes.some((prefix) => specifier.startsWith(prefix))),
  );
}

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
