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
import type { ApprovalReviewerBinding, RunResult } from "@agent-anything/agent-runtime/run";
import { Runner } from "@agent-anything/agent-runtime/runner";
import { CurrentValidationCompletionGate } from "@agent-anything/validation/completion";
import type { ContextManifestPersistencePort } from "@agent-anything/context/persistence";
import {
  createCanonicalActorIdentity,
  createCanonicalEnvironmentIdentity,
  createCanonicalSha256Digest,
  createCanonicalWorkspaceIdentity,
} from "@agent-anything/canonical-action/subject";
import {
  createAllowAllActionPolicyPort,
  type PersistentPolicyAmendmentPort,
} from "@agent-anything/governance";
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
  type HelarcToolMode,
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
  HELARC_RUN_COMMAND_BINDING,
  HELARC_RUN_COMMAND_OPERATION,
} from "@agent-anything/helarc/tools";
import { bindHelarcValidationCompletionGate } from "@agent-anything/helarc/validation";
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
import type { ModelContinuationStore } from "@agent-anything/model-interaction/continuation";
import type { RuntimeEvent, RuntimeEventPublisher } from "@agent-anything/observability/events";
import type { SessionAuthorityPort } from "@agent-anything/permission";
import type { WorkspaceIdentity } from "@agent-anything/workspace/identity";
import {
  listSelectedWorkspaces,
  type WorkspaceSelection,
} from "@agent-anything/workspace/selection";
import { createHelarcHostPermissionComposition } from "./HelarcHostPermissionComposition.js";

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
  readonly modelContinuationStore?: ModelContinuationStore;
  readonly contextManifestPersistence?: ContextManifestPersistencePort;
  readonly toolMode: HelarcToolMode;
  readonly permissionPreset: HelarcPermissionPreset;
  readonly automaticApprovalReviewer?: ApprovalReviewerBinding & {
    readonly kind: "auto_review";
  };
  readonly sessionAuthorityPort?: SessionAuthorityPort;
  readonly persistentPolicyAmendments?: PersistentPolicyAmendmentPort;
  readonly enforcement?: SandboxEnforcement;
  readonly sandboxProviders?: readonly SandboxProvider[];
  readonly commandLimits?: Partial<CodeAgentCommandLimits>;
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
  const commandActions = input.toolMode === "shell-enabled"
    ? await createHelarcLocalCommandActionCapability({
        workspace: runWorkspace,
        operation: HELARC_RUN_COMMAND_OPERATION,
        binding: HELARC_RUN_COMMAND_BINDING,
        limits: input.commandLimits,
        now,
      })
    : null;
  const product = await createHelarcProductComposition({
    runId: input.productRunId,
    task: input.task,
    workspace: runWorkspace,
    provider: input.provider,
    modelContinuationStore: input.modelContinuationStore,
    toolMode: input.toolMode,
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
      actionExecution: {
        registrations: product.actions.registrations,
        adapters: product.actions.adapters,
        policy: createAllowAllActionPolicyPort(now),
        sandbox,
        records: createInvocationLocalActionRecordPort(),
        retry: createStopActionRetryPort(),
        now,
      },
      ...(product.actions.composite === null ? {} : {
        composite: product.actions.composite,
      }),
    },
    validation: bindHelarcValidationCompletionGate(
      product.validation,
      new CurrentValidationCompletionGate(now),
    ),
    interactions: product.interactions,
    runtimeEventPublisher: productRuntimeEventPublisher,
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
        policySnapshotId: "helarc.allow-all.v1",
        securityContext,
        enforcement,
        metadata: runMetadata,
      },
      validation: {
        profile: product.validation.profile,
        completion: createHelarcValidationCompletionConfig(),
      },
      limits: {
        maxIterations: 5,
        maxActions: 8,
        maxConsecutiveActionFailures: 1,
        maxDurationMs: 30_000,
        maxPendingInteractions: 8,
        maxDescendantRuns: 4,
        maxDescendantDepth: 2,
        plan: {
          maxSteps: 12,
          maxStepLength: 300,
          maxExplanationLength: 1_000,
        },
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
            activeRun.getProjection().validation,
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

function createHelarcValidationCompletionConfig() {
  const owner = (id: string) => Object.freeze({
    owner: "helarc",
    kind: "validation",
    id,
    revision: "1",
  });
  return Object.freeze({
    policy: owner("current-validation-gate"),
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
