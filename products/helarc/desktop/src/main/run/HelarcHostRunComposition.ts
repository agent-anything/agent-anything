import type { RunInputItem } from "@agent-anything/agent-core/input";
import {withHelarcProviderAdmission, HELARC_PROVIDER_ADMISSION} from "../provider/HelarcProviderAdmission.js";
import {createHelarcContextPreparation, HELARC_CONTEXT_PREPARATION_BINDING} from "../execution-storage/HelarcContextPreparation.js";
import { createDefaultHelarcInstructionSettings, snapshotHelarcInstructionSettings, type HelarcInstructionSettings } from "@agent-anything/helarc/configuration";
import { randomUUID } from "node:crypto";
import { canonicalEncode } from "@agent-anything/canonical-action/subject";
import { createRunTranscriptRecord } from "@agent-anything/agent-runtime/transcript";
import type { HelarcExecutionStore } from "../execution-storage/HelarcExecutionStore.js";
import { retainHelarcProviderBinding, type HelarcExecutionAdmission } from "../execution-storage/HelarcExecutionAdmission.js";
import type { IdentityRef } from "@agent-anything/agent-core/run";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type {
  ActionRecordPort,
  ActionRetryDecisionPort,
} from "@agent-anything/action-execution/enforcement";
import type {
  SandboxEnforcement,
  SandboxProvider,
} from "@agent-anything/action-execution/sandbox";
import { createRunFailureCause, type ApprovalReviewerBinding, type RunFinalizationContext, type RunResult } from "@agent-anything/agent-runtime/run";
import {
  RunExecutionCoordinator,
  type RunLimits,
  type RunTreeLimits,
  type RunConfig,
  type RetainedRunConfig,
} from "@agent-anything/agent-runtime/execution-coordinator";
import type { RunTranscriptPort } from "@agent-anything/agent-runtime/transcript";
import type { ContextManifestPersistencePort } from "@agent-anything/context/persistence";
import {
  createCanonicalActorIdentity,
  createCanonicalEnvironmentIdentity,
  createCanonicalSha256Digest,
  createCanonicalWorkspaceIdentity,
} from "@agent-anything/canonical-action/subject";
import type { PersistentPolicyAmendmentPort } from "@agent-anything/governance";
import {
  createInMemoryHostPolicyAmendmentStore,
  createInMemoryHostSessionAuthorityStore,
} from "@agent-anything/host/authority";
import {
  resolveHostRunContext,
  type HostIdentityResolver,
  type HostIdentitySelection,
  type HostWorkspaceResolver,
  type HostWorkspaceSelection,
} from "@agent-anything/host/context";
import type { HostTerminalRunProjection } from "@agent-anything/host/projection";
import {
  createHostRunManager,
  type HostActiveRun,
} from "@agent-anything/host/run";
import type { HelarcPermissionPreset } from "@agent-anything/helarc/configuration";
import {
  createHelarcProductComposition,
  type HelarcActivityItem,
  type HelarcProductResult,
} from "@agent-anything/helarc/composition";
import {
  createHelarcContextProjectionConfiguration,
  type HelarcAgentOutput,
} from "@agent-anything/helarc/controller";
import type {
  HelarcProductRunProjection,
  HelarcProductRunProjectionListener,
} from "@agent-anything/helarc/run";
import type { HelarcTaskInput } from "@agent-anything/helarc/task";
import {
  HELARC_SHELL_BINDING,
  HELARC_SHELL_OPERATION,
  HELARC_PROCESS_START_BINDING,
  HELARC_PROCESS_START_OPERATION,
  HELARC_INITIAL_OBSERVATION_HANDLER,
  HELARC_COMMAND_OBSERVE_HANDLER,
  HELARC_TASK_STOP_BINDING,
  HELARC_TASK_STOP_OPERATION,
} from "@agent-anything/helarc/tools";
import type { CodeAgentCommandLimits } from "@agent-anything/helarc-local-environment/command";
import {
  createHelarcLocalCommandActionCapability,
} from "@agent-anything/helarc-local-environment/command";
import {
  createCodeAgentCanonicalWorkspaceRoots,
  createHelarcLocalFileActionCapability,
  createLocalCodeSourcePort,
} from "@agent-anything/helarc-local-environment/filesystem";
import { createHelarcLocalSandboxGateway } from "@agent-anything/helarc-local-environment/sandbox";
import type { Provider } from "@agent-anything/model-interaction";
import type { HelarcProviderProfile } from "@agent-anything/helarc/configuration";
import type { ModelContinuationStore } from "@agent-anything/model-interaction/continuation";
import type { RuntimeEvent, RuntimeEventPublisher } from "@agent-anything/observability/events";
import type { SessionAuthorizationStore } from "@agent-anything/permission";
import type { WorkspaceIdentity } from "@agent-anything/workspace/identity";
import {
  listSelectedWorkspaces,
  type WorkspaceSelection,
} from "@agent-anything/workspace/selection";
import { createHelarcHostPermissionComposition } from "./HelarcHostPermissionComposition.js";
import { createHelarcHostActionPolicy } from "./HelarcHostActionPolicy.js";

const HELARC_RUN_MAX_DURATION_MS = 30 * 60_000;
export const DEFAULT_HELARC_RUN_LIMITS: RunLimits = Object.freeze({
  maxIterations: 64,
  maxActions: 64,
  maxConsecutiveActionFailures: 8,
  maxDurationMs: HELARC_RUN_MAX_DURATION_MS,
  maxPendingInteractions: 8,
  plan: Object.freeze({ maxSteps: 24, maxStepLength: 500, maxExplanationLength: 2_000 }),
});
const HARD_HELARC_RUN_LIMITS: RunLimits = Object.freeze({
  maxIterations: 256,
  maxActions: 256,
  maxConsecutiveActionFailures: 32,
  maxDurationMs: 2 * 60 * 60_000,
  maxPendingInteractions: 32,
  plan: Object.freeze({ maxSteps: 64, maxStepLength: 2_000, maxExplanationLength: 8_000 }),
});
const DEFAULT_HELARC_RUN_TREE_LIMITS: RunTreeLimits = Object.freeze({
  maxTotalDescendantRuns: 8,
  maxActiveDescendantRuns: 4,
  maxDescendantDepth: 4,
});
const HARD_HELARC_RUN_TREE_LIMITS: RunTreeLimits = Object.freeze({
  maxTotalDescendantRuns: 32,
  maxActiveDescendantRuns: 8,
  maxDescendantDepth: 8,
});

export type HelarcHostRunLimitsInput = Partial<Omit<RunLimits, "plan">> & {
  readonly plan?: Partial<RunLimits["plan"]>;
};
export type HelarcHostRunTreeLimitsInput = Partial<RunTreeLimits>;

export interface PrepareHelarcHostRunInput {
  readonly executionStore?: HelarcExecutionStore;
  readonly recoveryAdmission?: HelarcExecutionAdmission;
  readonly commandOutputDirectory: string;
  readonly responseDelivery?: "buffered" | "streaming";
  readonly retainCommandOutput?: (runId: string, executionId: string, paths: import("@agent-anything/helarc-local-environment/command").ProcessOutputPaths) => Promise<void>;
  readonly inspection?: import("../inspection/HelarcInspection.js").HelarcInspection;
  readonly instructionSettings?: HelarcInstructionSettings;
  readonly sessionId: string;
  readonly productRunId: string;
  readonly task: AgentTask<HelarcTaskInput>;
  readonly inputItems: readonly RunInputItem[];
  readonly workspaceResolver: HostWorkspaceResolver;
  readonly workspaceSelection: HostWorkspaceSelection;
  readonly identityResolver: HostIdentityResolver;
  readonly identitySelection: HostIdentitySelection;
  readonly provider: Provider;
  readonly providerProfile: HelarcProviderProfile;
  readonly modelContinuationStore?: ModelContinuationStore;
  readonly contextManifestPersistence?: ContextManifestPersistencePort;
  readonly runTranscriptPort?: RunTranscriptPort;
  readonly permissionPreset: HelarcPermissionPreset;
  readonly automaticApprovalReviewer?: ApprovalReviewerBinding & {
    readonly kind: "auto_review";
  };
  readonly sessionAuthorityPort?: SessionAuthorizationStore;
  readonly persistentPolicyAmendments?: PersistentPolicyAmendmentPort;
  readonly enforcement?: SandboxEnforcement;
  readonly sandboxProviders?: readonly SandboxProvider[];
  readonly commandLimits?: Partial<CodeAgentCommandLimits>;
  readonly runLimits?: HelarcHostRunLimitsInput;
  readonly runTreeLimits?: HelarcHostRunTreeLimitsInput;
  readonly now?: () => string;
}

export interface HelarcHostRunResult {
  readonly kind: "run_result";
  readonly productRunId: string;
  readonly harnessRunId: string;
  readonly runResult: RunResult<HelarcAgentOutput>;
  readonly terminal: HostTerminalRunProjection;
  readonly product: HelarcProductResult;
  readonly activity: readonly HelarcActivityItem[];
}

export interface HelarcHostRunComposition {
  readonly activeRun: HelarcHostActiveRun;
  readonly result: Promise<HelarcHostRunResult>;
}

export interface PreparedHelarcHostRun {
  readonly rootRunId: string;
  readonly sessionId: string;
  readonly productRunId: string;
  readonly workspace: WorkspaceSelection;
  readonly identity: IdentityRef;
  start(): HelarcHostRunComposition;
  recover(intent?: "continue" | "cancel"): Promise<HelarcHostRunComposition>;
}

export interface HelarcHostActiveRun extends HostActiveRun<HelarcAgentOutput> {
  getResponsePreviews(): import("@agent-anything/helarc/run").HelarcResponsePreviews;
  subscribeResponsePreviews(listener:(state:import("@agent-anything/helarc/run").HelarcResponsePreviews,
    attempt:import("@agent-anything/helarc/run").HelarcResponsePreview) => void): () => void;
  readCommandOutput(runId: string, executionId: string, cursor?: string): ReturnType<import("@agent-anything/helarc-local-environment/command").RunProcessManager["readOutput"]>;
  getProductProjection(): HelarcProductRunProjection;
  subscribeProductProjection(listener: HelarcProductRunProjectionListener): () => void;
}

export async function prepareHelarcHostRun(
  input: PrepareHelarcHostRunInput,
): Promise<PreparedHelarcHostRun> {
  try { return await prepareHostRun(input); }
  catch (error) {
    if (input.recoveryAdmission) {
      const diagnostic = error && typeof error === "object" ? error as {code?: string; component?: string} : {};
      input.inspection?.recordRecoveryBindingCheck({runId: input.recoveryAdmission.rootRunId, outcome: "rejected",
        code: diagnostic.code ?? "recovery_binding_preparation_failed", component: diagnostic.component ?? "composition", changedVariableNames: []});
    }
    throw error;
  }
}

class HelarcRecoveryBindingError extends Error {
  readonly code = "recovery_binding_mismatch";
  constructor(readonly component: string) {
    super(`Original execution binding is unavailable: ${component}; recovery cannot use changed configuration.`);
    this.name = "HelarcRecoveryBindingError";
  }
}

async function prepareHostRun(input: PrepareHelarcHostRunInput): Promise<PreparedHelarcHostRun> {
  if (input.recoveryAdmission && (!input.executionStore || input.recoveryAdmission.version !== 2 ||
      input.recoveryAdmission.productRunId !== input.productRunId || input.recoveryAdmission.sessionId !== input.sessionId))
    throw new HelarcRecoveryBindingError("admission");
  const recoveryEnvironment = input.recoveryAdmission
    ? input.executionStore!.restoreCommandEnvironment(input.recoveryAdmission.commandEnvironment) : undefined;
  const rootRunId = input.recoveryAdmission?.rootRunId ?? `run_${randomUUID()}`;
  const instructionSettings = snapshotHelarcInstructionSettings(input.instructionSettings ?? createDefaultHelarcInstructionSettings());
  const runContext = await resolveHostRunContext({
    sessionId: input.sessionId,
    runId: input.productRunId,
    taskId: input.task.id,
    metadata: { product: "helarc" },
    workspaceResolver: input.workspaceResolver,
    identityResolver: input.identityResolver,
    workspaceSelection: input.workspaceSelection,
    identitySelection: input.identitySelection,
    workspaceRequirement: "required",
  });
  if (runContext.workspace === null) {
    throw new TypeError("Helarc requires a resolved Run Workspace.");
  }
  const now = input.now ?? (() => new Date().toISOString());
  const runLimits = resolveHelarcRunLimits(input.runLimits);
  const runTreeLimits = resolveHelarcRunTreeLimits(input.runTreeLimits);
  const runTreeResources = resolveHelarcRunTreeResources(runLimits, runTreeLimits);
  const runWorkspace = runContext.workspace;
  const workspace = runWorkspace.primary;
  const workspaceRoots = resolvePermissionWorkspaceRoots(runWorkspace);
  const platform = workspaceRoots.some((root) => /^[A-Za-z]:[\\/]/.test(root.path))
    ? "win32" as const
    : "posix" as const;
  const enforcement = input.enforcement ?? "disabled";
  const sandboxProviders = input.sandboxProviders ?? [];
  assertSelectedSandboxProvider(enforcement, sandboxProviders);

  const canonicalRoots = await createCodeAgentCanonicalWorkspaceRoots({
    workspace: runWorkspace,
    platform,
  });
  const permissions = await createHelarcHostPermissionComposition({
    preset: input.permissionPreset,
    productRunId: input.productRunId,
    sessionId: input.sessionId,
    workspace,
    workspaceRoots: canonicalRoots.map((root) => ({
      rootId: root.rootId,
      path: root.resolvedPath,
    })),
    platform,
    enforcement,
    automaticReviewer: input.automaticApprovalReviewer ?? null,
    sessionAuthorityPort: input.sessionAuthorityPort ??
      createInMemoryHostSessionAuthorityStore({ maxRecords: 64 }),
    persistentPolicyAmendments: input.persistentPolicyAmendments ??
      createInMemoryHostPolicyAmendmentStore({ maxRecords: 64 }),
  });
  const fileSupport = input.executionStore ? createHelarcFileSupport(input.executionStore, rootRunId) : undefined;
  const executionHandoff = input.executionStore ? createHelarcExecutionHandoff(input.executionStore) : undefined;
  const executionAccess: import("@agent-anything/operation-catalog/evidence").ExecutionEvidenceAccessPort = executionHandoff?.access ?? {async canInspect({runId, record}) {
    return record.source.correlation.kind === "run_action" && record.source.correlation.run.id === runId;
  }};
  const fileActions = createHelarcLocalFileActionCapability({
    workspace: runWorkspace,
    fileSupport: fileSupport?.support,
    executionEvidence: input.executionStore,
    executionAccess,
    now,
  });
  let reportCommand:(fact:import("@agent-anything/helarc-local-environment/command").ProcessExecutionFact)=>void=()=>{};
  const commandActions = await createHelarcLocalCommandActionCapability({
    recoveryEnvironment,
    processManagerId: `process-manager:${rootRunId}`,
    processRecords: input.executionStore,
    shellSessionRecords: input.executionStore,
    commandOutputDirectory: input.commandOutputDirectory,
    retainCommandOutput: input.retainCommandOutput,
    workspace: runWorkspace,
    platform,
    shellOperation: HELARC_PROCESS_START_OPERATION,
    shellBinding: HELARC_PROCESS_START_BINDING,
    initialObservationHandlerId: HELARC_INITIAL_OBSERVATION_HANDLER,
    commandObserveHandlerId: HELARC_COMMAND_OBSERVE_HANDLER,
    taskStopOperation: HELARC_TASK_STOP_OPERATION,
    taskStopBinding: HELARC_TASK_STOP_BINDING,
    limits: input.commandLimits,
    constraintObserver: input.inspection?.commandConstraintObserver,
    processObserver:fact=>{
      try { input.inspection?.processObserver?.(fact); } catch { /* Independent diagnostic consumer. */ }
      reportCommand(fact);
    },
    now,
  });
  const product = await createHelarcProductComposition({
    contextMaterials: input.executionStore?.contextMaterials,
    contextPreparation: input.executionStore ? createHelarcContextPreparation(input.executionStore) : undefined,
    materialHandoff: input.executionStore ? createHelarcMaterialHandoff(input.executionStore) : undefined,
    executionEvidence: input.executionStore,
    executionEvidenceAccess: executionAccess,
    executionMaterials: fileSupport?.materials,
    executionHandoff: executionHandoff?.handoff,
    executionCollections: executionHandoff?.collections,
    hookInvocationRecords: input.executionStore,
    responseDelivery: input.responseDelivery,
    runId: input.productRunId,
    task: input.task,
    workspace: runWorkspace,
    provider: withHelarcProviderAdmission(input.provider, input.inspection?.executionFlow),
    providerProfile: input.providerProfile,
    executionFlow: input.inspection?.executionFlow,
    instructionTarget: "production",
    instructionSettings,
    modelContinuationStore: input.modelContinuationStore,
    codeSource: createLocalCodeSourcePort(now),
    fileActions,
    commandActions,
    now,
  });
  const inspectionDefinitions = input.inspection?.definitions;
  if (inspectionDefinitions) {
    try {
      inspectionDefinitions.agent(product.agent);
      inspectionDefinitions.agent(product.delegatedAgent);
      inspectionDefinitions.tools(product.actions.toolSelection, product.actions.toolInputSemanticValidators);
      inspectionDefinitions.provider(input.provider.descriptor, input.provider.modelContext.target.revision);
      inspectionDefinitions.hooks(product.hookRegistrations);
      product.agentHooks.subscribe((projection) => inspectionDefinitions.hookInvocations(projection));
    } catch { /* Diagnostic capture cannot change Product composition. */ }
  }
  reportCommand=fact=>{
    const s=fact.snapshot;
    product.recordCommandProgress({runId:s.ref.runId,executionId:s.ref.executionId,revision:s.revision,phase:s.phase,
      processId:s.process?.processId ?? null,outcome:s.outcome,capturedBytes:s.output.retainedBytes,
      omittedBytes:s.output.omittedBytes,outputPersistence:s.output.persistence,observedAt:fact.occurredAt,
      command:commandActions.processes.getDisplayDescriptor(s.ref.runId,s.ref.executionId).command ?? undefined,
      shell:commandActions.processes.getDisplayDescriptor(s.ref.runId,s.ref.executionId).shell ?? undefined,
      cwd:s.initialCwd,startedAt:s.startedAt,completedAt:s.finishedAt,exitCode:s.rootExit?.code ?? null,
      invocationId:s.origin?.invocationId ?? null,attemptId:s.origin?.attemptId ?? null});
  };
  const executionBindings = {
      providerAdmission: HELARC_PROVIDER_ADMISSION,
      contextPreparation: HELARC_CONTEXT_PREPARATION_BINDING,
      platform,
      enforcement,
      commandEnvironment: commandActions.environment,
      shellRuntime: commandActions.shellRuntime,
      registrationFingerprints: product.actions.registrations.registrations.map(
        (registration) => registration.registrationFingerprint,
      ),
      operationBindingRevision: product.actions.operationBindings.revision,
      toolSelection: {
        id: product.actions.toolSelection.selectionId,
        revision: product.actions.toolSelection.revision,
      },
      workspaceRootFingerprints: canonicalRoots.map(
        (root) => root.resolutionFingerprint,
      ),
    };
  const configurationFingerprint = await createCanonicalSha256Digest("agent-anything.helarc.local-environment.v1", executionBindings);
  const securityContext = Object.freeze({
    workspace: createCanonicalWorkspaceIdentity({
      workspaceId: workspace.id,
      trustState: workspace.trustState,
      roots: canonicalRoots,
    }),
    actor: createCanonicalActorIdentity({
      identityId: runContext.identity.id,
      kind: runContext.identity.kind,
    }),
    environment: createCanonicalEnvironmentIdentity({
      environmentId: permissions.permissions.permissionProfile.environmentId,
      platform,
      configurationFingerprint,
    }),
  });
  const sandbox = createHelarcLocalSandboxGateway({
    executors: product.actions.executors,
    providers: sandboxProviders,
  });
  const productRuntimeEventPublisher: RuntimeEventPublisher = Object.freeze({
    publish(event: RuntimeEvent) {
      product.recordRuntimeEvent(event);
      try { input.inspection?.runtimeEvents?.publish(event); } catch { /* Diagnostic capture is optional. */ }
    },
  });
  const runMetadata = Object.freeze({
    ...product.runMetadata,
    enforcement,
  });
  const baseContextProjection = createHelarcContextProjectionConfiguration();
  const contextProjection = input.contextManifestPersistence === undefined
    ? baseContextProjection
    : Object.freeze({
        ...baseContextProjection,
        manifestPersistence: input.contextManifestPersistence,
      });
  let rootIdentityAllocated = false;
  const cleanupProcesses = async (context: RunFinalizationContext) => {
    const cleanup = await commandActions.processes.finalizeRun(context);
    return cleanup.completed ? null : createRunFailureCause("runtime", Object.freeze({
      code: cleanup.executions.some(execution => execution.limitations.includes("process_output_retention_failed"))
        ? "runtime_process_output_retention_failed" : "runtime_process_cleanup_failed",
      message: "Run-owned command cleanup or retained output could not be confirmed.",
      retryable: false, metadata: Object.freeze({runId: context.runId, cleanup}),
    }));
  };
  const runner = new RunExecutionCoordinator({
    createRunId: () => {
      if (!rootIdentityAllocated) {rootIdentityAllocated = true; return rootRunId;}
      return `run_${randomUUID()}`;
    },
    runTreeCommits: input.executionStore,
    compositeCommits: input.executionStore,
    compositeRecovery: input.executionStore,
    runObserver: {
      observe(observation) {
        try { product.recordRunLineage(observation.snapshot.runId, observation.lineage); } catch { /* Display is non-authoritative. */ }
        try { input.inspection?.runObserver?.observe(observation); } catch { /* Independent observer. */ }
      },
      transition(observation) { input.inspection?.runObserver?.transition?.(observation); },
    },
    runTraceObserver: input.inspection?.traceObserver,
    runTranscriptObserver: {
      observe(record) {
        try { product.recordTranscript(record); } catch { /* Display is non-authoritative. */ }
        try { input.inspection?.transcriptObserver?.observe(record); } catch { /* Independent observer. */ }
      },
    },
    executionObserver: {
      observe(observation) {
        if (observation.kind === "run_input" && observation.occurredAt !== null) {
          try { product.recordRunInput(observation.runId, observation.input, observation.occurredAt); } catch { /* Display is non-authoritative. */ }
        }
        try { input.inspection?.executionObserver?.observe(observation); } catch { /* Independent observer. */ }
      },
    },
    executionFlow: input.inspection?.executionFlow,
    taskDecisions: product.taskDecisions,
    extensions: product.extensions,
    preparations: product.preparations,
    inputNotifications: {read: (runId, afterSequence) => commandActions.processes.readInputNotifications(runId, afterSequence)},
    contextProjection,
    operations: {
      ...(input.executionStore ? {actionRecovery: {records: input.executionStore, attempts: null}} : {}),
      catalog: product.actions.operationCatalog,
      bindings: product.actions.operationBindings,
      toolInputSemanticValidators: product.actions.toolInputSemanticValidators,
      resultContracts: product.actions.resultContracts,
      resultPresenters: product.actions.resultPresenters,
      internalHandlers: product.actions.internalHandlers,
      composite: product.actions.composite,
      availability: product.actions.operationAvailability,
      actionExecution: {
        observer: input.inspection?.actionObserver,
        registrations: product.actions.registrations,
        adapters: product.actions.adapters,
        policy: createHelarcHostActionPolicy({
          permissionPreset: input.permissionPreset,
          now,
        }),
        sandbox,
        records: input.executionStore ?? createInvocationLocalActionRecordPort(),
        retry: createStopActionRetryPort(),
        now,
      },
      delegation: product.delegation,
    },
    interactions: product.interactions,
    runtimeEventPublisher: productRuntimeEventPublisher,
    runTranscriptPort: input.runTranscriptPort,
    resourceFinalizers: Object.freeze([Object.freeze({
      binding: {id: "helarc.command-cleanup", revision: "1"},
      finalize: cleanupProcesses,
      reconcile: cleanupProcesses,
    })]),
    now,
  });
  const manager = createHostRunManager({ runner, now });
  const hostRunStartInput = {
    sessionId: input.sessionId,
    agent: product.agent,
    runInput: {
      task: input.task,
      items: input.inputItems,
      metadata: runMetadata,
    },
    runConfig: {
      workspace: runWorkspace,
      identity: runContext.identity,
      permissions: permissions.permissions,
      tools: product.actions.toolSelection,
      actionExecution: {
        policySnapshotId: `helarc.action-policy.v1:${input.permissionPreset}`,
        securityContext,
        enforcement,
        metadata: runMetadata,
      },
      limits: runLimits,
      runTreeLimits,
      runTreeResources,
      runTreeApprovals: {
        maxTotalRequests: null,
        maxRequestsPerOperationFingerprint: null,
        maxConsecutiveDeclines: 3,
        maxConsecutiveReviewerFailures: 3,
        maxActiveReviews: 2,
      },
      audit: "optional",
      telemetry: "optional",
      cancellationLimits: {
        operationSettlementTimeoutMs: 10_000,
        processGracePeriodMs: 1_000,
        processForceKillTimeoutMs: 2_000,
        finalizationTimeoutMs: 5_000,
      },
      retry: {
        providerRequest: {
          maxRetries: 2,
          delay: {
            kind: "exponential_jitter",
            baseDelayMs: 500,
            maxDelayMs: 4_000,
            multiplier: 2,
            jitterRatio: 0.1,
          },
          retryableCategories: ["transport", "timeout", "rate_limit", "server_error"],
          serverDelay: { mode: "prefer_trusted", maxServerDelayMs: 10_000 },
        },
        structuredOutput: {
          maxRetries: 1,
          delay: {
            kind: "exponential_jitter",
            baseDelayMs: 0,
            maxDelayMs: 0,
            multiplier: 2,
            jitterRatio: 0.1,
          },
          retryableCategories: [
            "structured_output_syntax",
            "structured_output_schema",
            "structured_output_semantic",
            "agent_output_contract",
            "structured_output_size",
          ],
          serverDelay: { mode: "ignore" },
        },
        action: { maxAttempts: 1 },
      },
      metadata: runMetadata,
    },
  } as const;
  if (input.recoveryAdmission) {
    const retained = input.recoveryAdmission;
    if (!sameBinding(retained.providerBinding, retainHelarcProviderBinding(input.provider))) throw new HelarcRecoveryBindingError("provider");
    if (retained.environmentFingerprint !== configurationFingerprint || !sameBinding(retained.executionBindings, executionBindings)) {
      const original = retained.executionBindings as Record<string, unknown>;
      const changed = Object.entries(executionBindings).filter(([key, value]) => !sameBinding(original?.[key], value)).map(([key]) => key);
      throw new HelarcRecoveryBindingError(changed.join(", ") || "environmentFingerprint");
    }
    input.inspection?.recordRecoveryBindingCheck({runId: rootRunId, outcome: "accepted", code: null, component: "composition",
      changedVariableNames: Object.keys({...recoveryEnvironment!.environment, ...process.env})
        .filter(key => recoveryEnvironment!.environment[key] !== process.env[key]).sort()});
  } else if (input.executionStore) {
    await input.executionStore.admitProductRun({version: 2, rootRunId, productRunId: input.productRunId,
      sessionId: input.sessionId, createdAt: now(), task: input.task, inputItems: input.inputItems,
      workspace: runWorkspace, identity: runContext.identity, providerProfile: input.providerProfile,
      providerBinding: retainHelarcProviderBinding(input.provider),
      instructionSettings, permissionPreset: input.permissionPreset,
      enforcement, commandLimits: input.commandLimits ?? null, runLimits, runTreeLimits,
      responseDelivery: input.responseDelivery ?? "buffered", environmentFingerprint: configurationFingerprint,
      executionBindings, commandEnvironment: input.executionStore.retainCommandEnvironment(commandActions.recoveryEnvironment)});
  }
  if (input.executionStore) await input.inspection?.registerExecutionRecording(rootRunId, Boolean(input.recoveryAdmission), input.executionStore);
  let started = false;
  let releaseExecution: (() => void) | undefined;

  const wrap = (hostActiveRun: HostActiveRun<HelarcAgentOutput>): HelarcHostRunComposition => {
    const activeRun = createHelarcHostActiveRun(hostActiveRun, product.getProductProjection,
      product.subscribeProductProjection, product.getResponsePreviews, product.subscribeResponsePreviews, commandActions.processes);
    return Object.freeze({activeRun, result: activeRun.wait().then((outcome): HelarcHostRunResult => ({
      kind: "run_result", productRunId: input.productRunId, harnessRunId: outcome.runId, runResult: outcome.runResult,
      terminal: outcome.terminal, product: product.projectResult(outcome.runResult, enforcement),
      activity: product.getProductProjection().activity,
    })).finally(() => releaseExecution?.())});
  };

  return Object.freeze({
    rootRunId,
    sessionId: input.sessionId,
    productRunId: input.productRunId,
    workspace: runWorkspace,
    identity: runContext.identity,
    start(): HelarcHostRunComposition {
      if (started) {
        throw new Error("Prepared Helarc Host Run can be started only once.");
      }
      started = true;
      if (input.recoveryAdmission) throw new Error("A retained execution must use recover, not start.");
      releaseExecution = input.executionStore?.acquireRun(rootRunId);
      try { return wrap(manager.start(hostRunStartInput)); }
      catch (error) {releaseExecution?.(); throw error;}
    },
    async recover(intent: "continue" | "cancel" = "continue"): Promise<HelarcHostRunComposition> {
      if (started || !input.recoveryAdmission || !input.executionStore) throw new Error("Recovery admission is unavailable or already activated.");
      started = true;
      rootIdentityAllocated = true;
      releaseExecution = input.executionStore.acquireRun(rootRunId);
      try {
      const saved = await input.executionStore.readRunTree(rootRunId);
      if (!saved) throw new Error("Original Run Tree admission is unavailable.");
      for (const member of saved.members) {
        const runId = member.head.state.run.id;
        await commandActions.restoreRun(runId);
        product.recordRunLineage(runId, member.admission.lineage);
        product.recordRunInput(runId, member.admission.input, member.head.state.startedAt);
        for (const item of member.head.state.items) product.recordTranscript(createRunTranscriptRecord(item));
      }
      const host = await manager.recover({sessionId: input.sessionId, runId: rootRunId, taskId: input.task.id,
        startedAt: saved.commit.checkpoint.input.startedAt, enforcement,
        ...(intent === "cancel" ? {cancellation: {origin: "user" as const, reasonCode: "user_requested" as const}} : {}),
        bindings: {async resolve(member) {
          const definition = member.head.control.agentDefinition;
          const agent = [product.agent, product.delegatedAgent].find(candidate => candidate.id === definition.id && candidate.revision === definition.revision);
          if (!agent) throw new Error("Original Agent definition is unavailable.");
          return {agent, config: rebindConfiguration(member.admission.config, hostRunStartInput.runConfig)};
        }}});
      return wrap(host as HostActiveRun<HelarcAgentOutput>);
      } catch (error) {releaseExecution(); throw error;}
    },
  });
}

function sameBinding(a: unknown, b: unknown): boolean {
  const left = canonicalEncode("helarc.execution-binding.v1", a);
  const right = canonicalEncode("helarc.execution-binding.v1", b);
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function rebindConfiguration(saved: RetainedRunConfig, trusted: RunConfig): RunConfig {
  const reviewer = trusted.permissions.reviewer;
  if (saved.permissions.reviewer?.kind !== reviewer?.kind ||
      saved.permissions.reviewer?.kind === "auto_review" && (reviewer?.kind !== "auto_review" || saved.permissions.reviewer.bindingId !== reviewer.bindingId)) {
    throw new Error("Original approval reviewer is unavailable.");
  }
  return {...structuredClone(saved), permissions: {...structuredClone(saved.permissions), reviewer,
    sessionAuthority: saved.permissions.sessionAuthority === null ? null : {
      ...structuredClone(saved.permissions.sessionAuthority), port: trusted.permissions.sessionAuthority!.port},
    persistentPolicyAmendments: saved.permissions.persistentPolicyAmendments ? trusted.permissions.persistentPolicyAmendments : null}};
}

function createHelarcHostActiveRun(
  host: HostActiveRun<HelarcAgentOutput>,
  getProductProjection: () => HelarcProductRunProjection,
  subscribeProductProjection: (
    listener: HelarcProductRunProjectionListener,
  ) => () => void,
  getResponsePreviews: HelarcHostActiveRun["getResponsePreviews"],
  subscribeResponsePreviews: HelarcHostActiveRun["subscribeResponsePreviews"],
  processes: import("@agent-anything/helarc-local-environment/command").RunProcessManager,
): HelarcHostActiveRun {
  return Object.freeze({
    sessionId: host.sessionId,
    runId: host.runId,
    getProjection: () => host.getProjection(),
    subscribe: (listener: Parameters<HostActiveRun["subscribe"]>[0]) =>
      host.subscribe(listener),
    submitInteraction: (input: Parameters<HostActiveRun["submitInteraction"]>[0]) =>
      host.submitInteraction(input),
    steer: (input: Parameters<HostActiveRun["steer"]>[0]) => host.steer(input),
    resumeDescendant: (input: Parameters<HostActiveRun["resumeDescendant"]>[0]) =>
      host.resumeDescendant(input),
    cancel: (input: Parameters<HostActiveRun["cancel"]>[0]) => host.cancel(input),
    getStatus: () => host.getStatus(),
    wait: () => host.wait(),
    getResult: () => host.getResult(),
    getProductProjection,
    subscribeProductProjection,
    getResponsePreviews,
    subscribeResponsePreviews,
    readCommandOutput: (runId: string, executionId: string, cursor?: string) => processes.readOutput(runId, executionId, cursor),
  });
}

function createInvocationLocalActionRecordPort(): ActionRecordPort {
  let sequence = 0;
  const next = (phase: "pre" | "intent" | "attempt" | "retry" | "post"): string => {
    sequence += 1;
    return `helarc-action-${phase}-${sequence}`;
  };
  return Object.freeze({
    async recordPreparedAction() {
      return Object.freeze({recordId: next("pre")});
    },
    async recordPreEffect() {
      return Object.freeze({ recordId: next("pre") });
    },
    async recordDispatchIntent() {
      return Object.freeze({ recordId: next("intent") });
    },
    async recordAttemptResult() {
      return Object.freeze({ recordId: next("attempt") });
    },
    async recordRetry() {
      return Object.freeze({recordId: next("retry")});
    },
    async recordPostEffect() {
      return Object.freeze({ recordId: next("post") });
    },
  });
}

function createStopActionRetryPort(): ActionRetryDecisionPort {
  return Object.freeze({
    async decide() {
      return Object.freeze({
        status: "stop" as const,
        code: "helarc_action_retry_not_configured",
      });
    },
    async wait({ delayMs, interruption }: Parameters<ActionRetryDecisionPort["wait"]>[0]) {
      if (interruption.signal.aborted) return "interrupted" as const;
      if (delayMs === 0) return "elapsed" as const;
      return new Promise<"elapsed" | "interrupted">((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve("interrupted");
        };
        const timer = setTimeout(() => {
          interruption.signal.removeEventListener("abort", onAbort);
          resolve("elapsed");
        }, delayMs);
        interruption.signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  });
}

function resolvePermissionWorkspaceRoots(
  workspace: WorkspaceSelection,
): Array<{ rootId: string; path: string }> {
  const roots = listSelectedWorkspaces(workspace).map((candidate) => ({
    rootId: candidate.id,
    path: requireWorkspacePath(candidate),
  }));
  if (roots.length === 0) {
    throw new TypeError("Helarc requires at least one permission workspace root.");
  }
  return roots;
}

function requireWorkspacePath(workspace: WorkspaceIdentity): string {
  if (workspace.rootRef === null || workspace.rootRef.trim().length === 0) {
    throw new TypeError(`Workspace '${workspace.id}' has no filesystem root.`);
  }
  return workspace.rootRef;
}

function assertSelectedSandboxProvider(
  enforcement: SandboxEnforcement,
  providers: readonly SandboxProvider[],
): void {
  if (enforcement === "disabled") return;
  if (!providers.some((provider) => provider.kind === enforcement)) {
    throw new TypeError(
      `Helarc '${enforcement}' enforcement requires a matching SandboxProvider.`,
    );
  }
}

function resolveHelarcRunLimits(input: HelarcHostRunLimitsInput | undefined): RunLimits {
  const value = {
    ...DEFAULT_HELARC_RUN_LIMITS,
    ...input,
    plan: { ...DEFAULT_HELARC_RUN_LIMITS.plan, ...input?.plan },
  };
  const fields: Array<keyof Omit<RunLimits, "plan">> = [
    "maxIterations", "maxActions", "maxConsecutiveActionFailures", "maxDurationMs",
    "maxPendingInteractions",
  ];
  for (const field of fields) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 1 || value[field] > HARD_HELARC_RUN_LIMITS[field]) {
      throw new TypeError(`Helarc Run limit '${field}' is outside the admitted range.`);
    }
  }
  for (const field of ["maxSteps", "maxStepLength", "maxExplanationLength"] as const) {
    if (!Number.isSafeInteger(value.plan[field]) || value.plan[field] < 1 || value.plan[field] > HARD_HELARC_RUN_LIMITS.plan[field]) {
      throw new TypeError(`Helarc Plan limit '${field}' is outside the admitted range.`);
    }
  }
  return Object.freeze({
    ...value,
    plan: Object.freeze(value.plan),
  });
}

function resolveHelarcRunTreeLimits(
  input: HelarcHostRunTreeLimitsInput | undefined,
): RunTreeLimits {
  const value = { ...DEFAULT_HELARC_RUN_TREE_LIMITS, ...input };
  for (const field of [
    "maxTotalDescendantRuns",
    "maxActiveDescendantRuns",
    "maxDescendantDepth",
  ] as const) {
    if (
      !Number.isSafeInteger(value[field]) ||
      value[field] < 0 ||
      value[field] > HARD_HELARC_RUN_TREE_LIMITS[field]
    ) {
      throw new TypeError(
        `Helarc Run Tree limit '${field}' is outside the admitted range.`,
      );
    }
  }
  return Object.freeze(value);
}

function resolveHelarcRunTreeResources(
  runLimits: RunLimits,
  treeLimits: RunTreeLimits,
): import("@agent-anything/agent-runtime/execution-coordinator").RunTreeResourceEnvelope {
  const runCapacity = treeLimits.maxTotalDescendantRuns + 1;
  return Object.freeze({
    controllerTurns: Object.freeze({
      maximum: runLimits.maxIterations * runCapacity,
      minimumChildGrant: 1,
      enforcement: "hard" as const,
    }),
    actions: Object.freeze({
      maximum: runLimits.maxActions * runCapacity,
      minimumChildGrant: 1,
      enforcement: "hard" as const,
    }),
    modelInputTokens: Object.freeze({
      threshold: 2_000_000 * runCapacity,
      enforcement: "observational" as const,
    }),
    modelOutputTokens: Object.freeze({
      threshold: 500_000 * runCapacity,
      enforcement: "observational" as const,
    }),
    costUnits: Object.freeze({
      threshold: 2_000_000 * runCapacity,
      enforcement: "observational" as const,
    }),
    contextBytes: Object.freeze({
      maximum: 8_000_000 * runCapacity,
      minimumChildGrant: 1,
      enforcement: "hard" as const,
    }),
    resultBytes: Object.freeze({
      maximum: 2_000_000 * runCapacity,
      minimumChildGrant: 1,
      enforcement: "hard" as const,
    }),
  });
}
import { createHelarcFileSupport } from "../execution-storage/HelarcFileSupport.js";
import { createHelarcExecutionHandoff } from "../execution-storage/HelarcExecutionHandoff.js";
import {createHelarcMaterialHandoff} from "../execution-storage/HelarcMaterialHandoff.js";
