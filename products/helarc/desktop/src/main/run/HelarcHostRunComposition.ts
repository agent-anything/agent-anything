import type { RunInputItem } from "@agent-anything/agent-core/input";
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
  Runner,
  type RunLimits,
  type RunTreeLimits,
} from "@agent-anything/agent-runtime/runner";
import { CurrentVerificationCompletionGate } from "@agent-anything/verification/completion";
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
  validateHelarcToolInput,
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
  HELARC_TASK_STOP_BINDING,
  HELARC_TASK_STOP_OPERATION,
} from "@agent-anything/helarc/tools";
import { bindHelarcVerificationCompletionGate } from "@agent-anything/helarc/verification";
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
import type { HelarcModelQualificationCatalog } from "@agent-anything/helarc/model-qualification";
import type { ModelContinuationStore } from "@agent-anything/model-interaction/continuation";
import type { RuntimeEvent, RuntimeEventPublisher } from "@agent-anything/observability/events";
import type { SessionAuthorityPort } from "@agent-anything/permission";
import type { WorkspaceIdentity } from "@agent-anything/workspace/identity";
import {
  listSelectedWorkspaces,
  type WorkspaceSelection,
} from "@agent-anything/workspace/selection";
import { createHelarcHostPermissionComposition } from "./HelarcHostPermissionComposition.js";
import { createHelarcHostActionPolicy } from "./HelarcHostActionPolicy.js";

const HELARC_RUN_MAX_DURATION_MS = 30 * 60_000;
const DEFAULT_HELARC_RUN_LIMITS: RunLimits = Object.freeze({
  maxIterations: 64,
  maxActions: 64,
  maxConsecutiveActionFailures: 8,
  maxDurationMs: HELARC_RUN_MAX_DURATION_MS,
  maxPendingInteractions: 8,
  plan: Object.freeze({ maxSteps: 24, maxStepLength: 500, maxExplanationLength: 2_000 }),
  progress: Object.freeze({
    checkpointWindowSize: 8,
    nonAdvancingCheckpointThreshold: 4,
    maxCorrectionRounds: 2,
  }),
});
const HARD_HELARC_RUN_LIMITS: RunLimits = Object.freeze({
  maxIterations: 256,
  maxActions: 256,
  maxConsecutiveActionFailures: 32,
  maxDurationMs: 2 * 60 * 60_000,
  maxPendingInteractions: 32,
  plan: Object.freeze({ maxSteps: 64, maxStepLength: 2_000, maxExplanationLength: 8_000 }),
  progress: Object.freeze({
    checkpointWindowSize: 64,
    nonAdvancingCheckpointThreshold: 32,
    maxCorrectionRounds: 8,
  }),
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

export type HelarcHostRunLimitsInput = Partial<Omit<RunLimits, "plan" | "progress">> & {
  readonly plan?: Partial<RunLimits["plan"]>;
  readonly progress?: Partial<RunLimits["progress"]>;
};
export type HelarcHostRunTreeLimitsInput = Partial<RunTreeLimits>;

export interface PrepareHelarcHostRunInput {
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
  readonly qualificationCatalog?: HelarcModelQualificationCatalog;
  readonly modelContinuationStore?: ModelContinuationStore;
  readonly contextManifestPersistence?: ContextManifestPersistencePort;
  readonly permissionPreset: HelarcPermissionPreset;
  readonly automaticApprovalReviewer?: ApprovalReviewerBinding & {
    readonly kind: "auto_review";
  };
  readonly sessionAuthorityPort?: SessionAuthorityPort;
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
  readonly sessionId: string;
  readonly productRunId: string;
  readonly workspace: WorkspaceSelection;
  readonly identity: IdentityRef;
  start(): HelarcHostRunComposition;
}

export interface HelarcHostActiveRun extends HostActiveRun<HelarcAgentOutput> {
  getProductProjection(): HelarcProductRunProjection;
  subscribeProductProjection(listener: HelarcProductRunProjectionListener): () => void;
}

export async function prepareHelarcHostRun(
  input: PrepareHelarcHostRunInput,
): Promise<PreparedHelarcHostRun> {
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
  const fileActions = createHelarcLocalFileActionCapability({
    workspace: runWorkspace,
    now,
  });
  const commandActions = await createHelarcLocalCommandActionCapability({
    workspace: runWorkspace,
    platform,
    shellOperation: HELARC_SHELL_OPERATION,
    shellBinding: HELARC_SHELL_BINDING,
    taskStopOperation: HELARC_TASK_STOP_OPERATION,
    taskStopBinding: HELARC_TASK_STOP_BINDING,
    limits: input.commandLimits,
    now,
  });
  const product = await createHelarcProductComposition({
    runId: input.productRunId,
    task: input.task,
    workspace: runWorkspace,
    provider: input.provider,
    providerProfile: input.providerProfile,
    qualificationCatalog: input.qualificationCatalog,
    instructionTarget: "production",
    modelContinuationStore: input.modelContinuationStore,
    codeSource: createLocalCodeSourcePort(now),
    fileActions,
    commandActions,
    now,
  });
  const configurationFingerprint = await createCanonicalSha256Digest(
    "agent-anything.helarc.local-environment.v1",
    {
      platform,
      enforcement,
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
    },
  );
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
    },
  });
  const runMetadata = Object.freeze({
    ...product.runMetadata,
    enforcement,
  });
  const baseContextProjection = createHelarcContextProjectionConfiguration(
    input.provider.inputAccounting,
    product.controllerProtocol,
  );
  const contextProjection = input.contextManifestPersistence === undefined
    ? baseContextProjection
    : Object.freeze({
        ...baseContextProjection,
        manifestPersistence: input.contextManifestPersistence,
      });
  const runner = new Runner({
    controller: product.controller,
    contextProjection,
    operations: {
      catalog: product.actions.operationCatalog,
      bindings: product.actions.operationBindings,
      validateToolInput: validateHelarcToolInput,
      internalHandlers: Object.freeze([]),
      availability: product.actions.operationAvailability,
      actionExecution: {
        registrations: product.actions.registrations,
        adapters: product.actions.adapters,
        policy: createHelarcHostActionPolicy({
          permissionPreset: input.permissionPreset,
          now,
        }),
        sandbox,
        records: createInvocationLocalActionRecordPort(),
        retry: createStopActionRetryPort(),
        now,
      },
      delegation: product.delegation,
    },
    verification: bindHelarcVerificationCompletionGate(
      product.verification,
      new CurrentVerificationCompletionGate(now),
    ),
    interactions: product.interactions,
    runtimeEventPublisher: productRuntimeEventPublisher,
    resourceFinalizers: Object.freeze([Object.freeze({
      async finalize(context: RunFinalizationContext) {
        const completed = await commandActions.processTasks.finalizeRun(context.runId);
        return completed ? null : createRunFailureCause("runtime", Object.freeze({
          code: "runtime_process_cleanup_failed",
          message: "Run-owned background process cleanup could not be confirmed.",
          retryable: false,
          metadata: Object.freeze({ runId: context.runId }),
        }));
      },
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
      verification: {
        profile: product.verification.profile,
        completion: createHelarcVerificationCompletionConfig(),
      },
      limits: runLimits,
      runTreeLimits,
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
  let started = false;

  return Object.freeze({
    sessionId: input.sessionId,
    productRunId: input.productRunId,
    workspace: runWorkspace,
    identity: runContext.identity,
    start(): HelarcHostRunComposition {
      if (started) {
        throw new Error("Prepared Helarc Host Run can be started only once.");
      }
      started = true;
      const hostActiveRun = manager.start(hostRunStartInput);
      const activeRun = createHelarcHostActiveRun(
        hostActiveRun,
        product.getProductProjection,
        product.subscribeProductProjection,
      );

      return Object.freeze({
        activeRun,
        result: activeRun.wait().then((outcome): HelarcHostRunResult => {
          const productResult = product.projectResult(
            outcome.runResult,
            enforcement,
            activeRun.getProjection().verification,
          );
          return Object.freeze({
            kind: "run_result",
            productRunId: input.productRunId,
            harnessRunId: outcome.runId,
            runResult: outcome.runResult,
            terminal: outcome.terminal,
            product: productResult,
            activity: product.getProductProjection().activity,
          });
        }),
      });
    },
  });
}

function createHelarcVerificationCompletionConfig() {
  const owner = (id: string) => Object.freeze({
    owner: "helarc",
    kind: "verification",
    id,
    revision: "1",
  });
  return Object.freeze({
    policy: owner("current-verification-gate"),
    outputContract: owner("agent-output-contract"),
    conditions: Object.freeze([]),
    maximumDurationMs: 5_000,
  });
}

function createHelarcHostActiveRun(
  host: HostActiveRun<HelarcAgentOutput>,
  getProductProjection: () => HelarcProductRunProjection,
  subscribeProductProjection: (
    listener: HelarcProductRunProjectionListener,
  ) => () => void,
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
    cancel: (input: Parameters<HostActiveRun["cancel"]>[0]) => host.cancel(input),
    getStatus: () => host.getStatus(),
    wait: () => host.wait(),
    getResult: () => host.getResult(),
    getProductProjection,
    subscribeProductProjection,
  });
}

function createInvocationLocalActionRecordPort(): ActionRecordPort {
  let sequence = 0;
  const next = (phase: "pre" | "post"): string => {
    sequence += 1;
    return `helarc-action-${phase}-${sequence}`;
  };
  return Object.freeze({
    async recordPreEffect() {
      return Object.freeze({ recordId: next("pre") });
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
    progress: { ...DEFAULT_HELARC_RUN_LIMITS.progress, ...input?.progress },
  };
  const fields: Array<keyof Omit<RunLimits, "plan" | "progress">> = [
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
  for (const field of [
    "checkpointWindowSize",
    "nonAdvancingCheckpointThreshold",
    "maxCorrectionRounds",
  ] as const) {
    if (
      !Number.isSafeInteger(value.progress[field]) ||
      value.progress[field] < 1 ||
      value.progress[field] > HARD_HELARC_RUN_LIMITS.progress[field]
    ) {
      throw new TypeError(`Helarc Run progress limit '${field}' is outside the admitted range.`);
    }
  }
  if (value.progress.nonAdvancingCheckpointThreshold > value.progress.checkpointWindowSize) {
    throw new TypeError("Helarc Run progress threshold cannot exceed its checkpoint window.");
  }
  return Object.freeze({
    ...value,
    plan: Object.freeze(value.plan),
    progress: Object.freeze(value.progress),
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
