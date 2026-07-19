import {
  ActionEnforcementPipeline,
  RuntimeEventEmitter,
  createCanonicalSha256Digest,
  createSandboxExecutionGateway,
  type AgentTask,
  type ApprovalReviewerBinding,
  type RunCancellationController,
  type RunResult,
  type SandboxEnforcement,
  type SandboxProvider,
} from "@agent-anything/agent-core";
import { Runner } from "@agent-anything/agent-runtime";
import {
  createInMemoryHostPolicyAmendmentStore,
  createInMemoryHostSessionAuthorityStore,
  createHostRuntime,
  type HostActiveRun,
  type HostRunStartFailure,
  type HostTerminalRunProjection,
  type UserApprovalReviewBridge,
} from "@agent-anything/host";
import {
  createCodeAgentCanonicalWorkspaceRoots,
  type CodeAgentCommandLimits,
} from "@agent-anything/code-agent";
import { EvidenceBuilder, type Evidence } from "@agent-anything/evidence";
import {
  createAllowAllActionPolicyPort,
  type PersistentPolicyAmendmentPort,
  type WorkspaceContext,
} from "@agent-anything/governance";
import {
  createHelarcProductComposition,
  type HelarcActivityItem,
  type HelarcAgentOutput,
  type HelarcPatchReviewBridge,
  type HelarcPatchReviewDecisionSubmission,
  type HelarcPatchReviewSubmissionReceipt,
  type HelarcPendingPatchReviewProjection,
  type HelarcProductRunProjection,
  type HelarcProductRunProjectionListener,
  type HelarcPermissionPreset,
  type HelarcProductResult,
  type HelarcTaskInput,
  type HelarcToolMode,
} from "@agent-anything/helarc";
import type { SessionAuthorityPort } from "@agent-anything/permission";
import type { Provider } from "@agent-anything/providers";
import type { ArtifactRef, ISODateTimeString } from "@agent-anything/shared";
import type { StoragePort, StoredArtifact } from "@agent-anything/storage";
import { createHelarcHostPermissionComposition } from "./HelarcHostPermissionComposition.js";

export interface PrepareHelarcHostRunInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly task: AgentTask<HelarcTaskInput>;
  readonly provider: Provider;
  readonly cancellation: RunCancellationController;
  readonly toolMode: HelarcToolMode;
  readonly permissionPreset: HelarcPermissionPreset;
  readonly userApprovalBridge?: UserApprovalReviewBridge;
  readonly automaticApprovalReviewer?: ApprovalReviewerBinding & {
    readonly kind: "auto_review";
  };
  readonly sessionAuthorityPort?: SessionAuthorityPort;
  readonly persistentPolicyAmendments?: PersistentPolicyAmendmentPort;
  readonly enforcement?: SandboxEnforcement;
  readonly sandboxProviders?: readonly SandboxProvider[];
  readonly commandLimits?: Partial<CodeAgentCommandLimits>;
  readonly patchReviewBridge: HelarcPatchReviewBridge;
  readonly storage?: StoragePort;
  readonly now?: () => ISODateTimeString;
}

export interface HelarcHostRunResult {
  readonly kind: "run_result";
  readonly runResult: RunResult<HelarcAgentOutput>;
  readonly terminal: HostTerminalRunProjection;
  readonly product: HelarcProductResult;
  readonly activity: readonly HelarcActivityItem[];
}

export interface HelarcHostRunStartFailureResult {
  readonly kind: "start_failure";
  readonly failure: HostRunStartFailure;
  readonly activity: readonly HelarcActivityItem[];
}

export type HelarcHostRunOutcome =
  | HelarcHostRunResult
  | HelarcHostRunStartFailureResult;

export interface HelarcHostRunComposition {
  readonly activeRun: HelarcHostActiveRun;
  readonly result: Promise<HelarcHostRunOutcome>;
}

export interface PreparedHelarcHostRun {
  readonly sessionId: string;
  readonly runId: string;
  start(): HelarcHostRunComposition;
}

export interface HelarcHostActiveRun extends HostActiveRun<HelarcAgentOutput> {
  getPatchReviewProjection(): HelarcPendingPatchReviewProjection | null;
  getProductProjection(): HelarcProductRunProjection;
  subscribeProductProjection(listener: HelarcProductRunProjectionListener): () => void;
  submitPatchReviewDecision(
    input: HelarcPatchReviewDecisionSubmission,
  ): HelarcPatchReviewSubmissionReceipt;
}

export async function prepareHelarcHostRun(
  input: PrepareHelarcHostRunInput,
): Promise<PreparedHelarcHostRun> {
  const workspace = resolveHelarcRunWorkspace(input.task);
  const workspaceRoots = resolvePermissionWorkspaceRoots(input.task);
  const platform = workspaceRoots.some((root) => /^[A-Za-z]:[\\/]/.test(root.path))
    ? "win32" as const
    : "posix" as const;
  const enforcement = input.enforcement ?? "disabled";
  const sandboxProviders = input.sandboxProviders ?? [];
  assertSelectedSandboxProvider(enforcement, sandboxProviders);
  assertPatchReviewBridge(input.runId, input.patchReviewBridge);

  const canonicalRoots = await createCodeAgentCanonicalWorkspaceRoots({
    workspaceScope: input.task.workspaceScope,
    platform,
  });
  const permissions = await createHelarcHostPermissionComposition({
    preset: input.permissionPreset,
    runId: input.runId,
    sessionId: input.sessionId,
    workspace,
    workspaceRoots: canonicalRoots.map((root) => ({
      rootId: root.rootId,
      path: root.resolvedPath,
    })),
    platform,
    enforcement,
    cancellation: input.cancellation,
    userApprovalBridge: input.userApprovalBridge ?? null,
    automaticReviewer: input.automaticApprovalReviewer ?? null,
    sessionAuthorityPort: input.sessionAuthorityPort ??
      createInMemoryHostSessionAuthorityStore({ maxRecords: 64 }),
    persistentPolicyAmendments: input.persistentPolicyAmendments ??
      createInMemoryHostPolicyAmendmentStore({ maxRecords: 64 }),
  });
  const product = await createHelarcProductComposition({
    runId: input.runId,
    task: input.task,
    provider: input.provider,
    toolMode: input.toolMode,
    commandLimits: input.commandLimits,
    patchReviewBridge: input.patchReviewBridge,
    now: input.now,
  });
  const actionEnforcementPipeline = new ActionEnforcementPipeline({
    registrations: product.actions.registrations,
    adapters: product.actions.adapters,
    policyPort: createAllowAllActionPolicyPort(),
    now: input.now,
  });
  const sandboxExecutionGateway = createSandboxExecutionGateway({
    registrations: product.actions.registrations,
    executors: product.actions.executors,
    providers: sandboxProviders,
    limits: { maxResultBytes: 2 * 1024 * 1024 },
    now: input.now,
  });
  const runtimeEvents = new RuntimeEventEmitter();
  runtimeEvents.subscribe((event) => {
    product.recordRuntimeEvent(event);
  });
  const runMetadata = Object.freeze({
    ...product.runMetadata,
    enforcement,
  });
  const runner = new Runner({
    controller: product.controller,
    actionEnforcementPipeline,
    sandboxExecutionGateway,
    evidenceBuilder: new EvidenceBuilder(),
    evidenceStorage: input.storage ?? new InMemoryHelarcHostStorage(input.now),
    eventEmitter: runtimeEvents,
    now: input.now,
  });
  const runtime = createHostRuntime({ runner, now: input.now });
  const configurationFingerprint = await createCanonicalSha256Digest(
    "agent-anything.helarc.local-environment.v1",
    {
      platform,
      enforcement,
      registrationFingerprints: product.actions.registrations.registrations.map(
        (registration) => registration.registrationFingerprint,
      ),
      workspaceRootFingerprints: canonicalRoots.map(
        (root) => root.resolutionFingerprint,
      ),
    },
  );
  const hostRunStartInput = {
    sessionId: input.sessionId,
    agent: product.agent,
    userApprovalReviewBridge: permissions.userApprovalBridge,
    runInput: {
      runId: input.runId,
      task: input.task,
      conversationItems: [],
      metadata: runMetadata,
    },
    runConfig: {
      workspace,
      identity: {
        id: input.sessionId,
        kind: "anonymous",
        displayName: "Helarc user",
        metadata: { product: "helarc" },
      },
      actionContext: {
        workspace: {
          workspaceId: workspace.id,
          trustState: workspace.trustState,
          roots: canonicalRoots,
        },
        actor: { identityId: input.sessionId, kind: "anonymous" },
        environment: {
          environmentId: permissions.permissions.permissionProfile.environmentId,
          platform,
          configurationFingerprint,
        },
      },
      permissions: permissions.permissions,
      limits: {
        maxIterations: 5,
        maxActions: 8,
        maxConsecutiveActionFailures: 1,
        maxDurationMs: 30_000,
        plan: {
          maxSteps: 12,
          maxStepLength: 300,
          maxExplanationLength: 1_000,
        },
      },
      audit: "optional",
      telemetry: "optional",
      cancellation: input.cancellation,
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
        approvalsReviewer: {
          maxRetries: 0,
          delay: {
            kind: "exponential_jitter",
            baseDelayMs: 0,
            maxDelayMs: 0,
            multiplier: 2,
            jitterRatio: 0.1,
          },
          retryableCategories: [],
          serverDelay: { mode: "ignore" },
        },
      },
      metadata: runMetadata,
    },
  } as const;
  let started = false;

  return Object.freeze({
    sessionId: input.sessionId,
    runId: input.runId,
    start(): HelarcHostRunComposition {
      if (started) {
        throw new Error("Prepared Helarc Host Run can be started only once.");
      }
      started = true;
      const platformActiveRun = runtime.start(hostRunStartInput);
      const activeRun = createHelarcHostActiveRun(
        platformActiveRun,
        input.patchReviewBridge,
        product.getProductProjection,
        product.subscribeProductProjection,
      );

      return Object.freeze({
        activeRun,
        result: activeRun.result.then((outcome): HelarcHostRunOutcome => {
          if (outcome.kind === "start_failure") {
            return Object.freeze({
              kind: "start_failure",
              failure: outcome,
              activity: product.getProductProjection().activity,
            });
          }
          const productResult = product.projectResult(outcome.runResult, enforcement);
          return Object.freeze({
            kind: "run_result",
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

function createHelarcHostActiveRun(
  platform: HostActiveRun<HelarcAgentOutput>,
  patchReviews: HelarcPatchReviewBridge,
  getProductProjection: () => HelarcProductRunProjection,
  subscribeProductProjection: (
    listener: HelarcProductRunProjectionListener,
  ) => () => void,
): HelarcHostActiveRun {
  return Object.freeze({
    sessionId: platform.sessionId,
    runId: platform.runId,
    getProjection: () => platform.getProjection(),
    subscribe: (listener: Parameters<HostActiveRun["subscribe"]>[0]) =>
      platform.subscribe(listener),
    submitApprovalDecision: (input: Parameters<HostActiveRun["submitApprovalDecision"]>[0]) =>
      platform.submitApprovalDecision(input),
    cancel: (input: Parameters<HostActiveRun["cancel"]>[0]) => platform.cancel(input),
    getPatchReviewProjection: () => patchReviews.getPendingProjection(),
    getProductProjection,
    subscribeProductProjection,
    submitPatchReviewDecision(
      input: HelarcPatchReviewDecisionSubmission,
    ): HelarcPatchReviewSubmissionReceipt {
      return patchReviews.submitDecision(input);
    },
    result: platform.result,
  });
}

function assertPatchReviewBridge(
  runId: string,
  bridge: HelarcPatchReviewBridge,
): void {
  if (
    bridge === null ||
    typeof bridge !== "object" ||
    typeof bridge.review !== "function" ||
    typeof bridge.getPendingProjection !== "function" ||
    typeof bridge.subscribe !== "function" ||
    typeof bridge.submitDecision !== "function"
  ) {
    throw new TypeError("Helarc Host Run requires a Patch review bridge.");
  }
  if (bridge.runId !== runId) {
    throw new TypeError("Helarc patch review bridge Run identity does not match the Run.");
  }
}

function resolveHelarcRunWorkspace(task: AgentTask): WorkspaceContext {
  const scope = task.workspaceScope;
  if (!scope) throw new TypeError("Helarc requires a task workspace scope.");
  if (scope.defaultRootName !== undefined) {
    const workspace = scope.roots[scope.defaultRootName];
    if (workspace) return workspace;
  }
  const workspaces = Object.values(scope.roots);
  if (workspaces.length === 1 && workspaces[0]) return workspaces[0];
  throw new TypeError("Helarc requires one resolvable default workspace.");
}

function resolvePermissionWorkspaceRoots(
  task: AgentTask,
): Array<{ rootId: string; path: string }> {
  const scope = task.workspaceScope;
  if (!scope) throw new TypeError("Helarc requires workspace roots for permission resolution.");
  const roots = Object.entries(scope.roots).map(([rootName, workspace]) => ({
    rootId: workspace.id || rootName,
    path: requireWorkspacePath(workspace),
  }));
  if (roots.length === 0) {
    throw new TypeError("Helarc requires at least one permission workspace root.");
  }
  return roots;
}

function requireWorkspacePath(workspace: WorkspaceContext): string {
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

class InMemoryHelarcHostStorage implements StoragePort {
  private nextId = 1;

  constructor(private readonly now: (() => ISODateTimeString) | undefined) {}

  async storeEvidence(evidence: Evidence): Promise<StoredArtifact> {
    const id = `helarc_artifact_${this.nextId}`;
    this.nextId += 1;
    return {
      id,
      kind: "evidence",
      ref: `memory://${evidence.id}` as ArtifactRef,
      createdAt: this.now?.() ?? new Date().toISOString(),
      metadata: { evidenceId: evidence.id },
    };
  }
}
