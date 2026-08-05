import {
  ActionEnforcementPipeline,
  createCanonicalSha256Digest,
  createSandboxExecutionGateway,
  type SandboxEnforcement,
  type SandboxProvider,
} from "@agent-anything/action-execution";
import type { RunResult } from "@agent-anything/agent-runtime/run";
import type {
  RuntimeEvent,
  RuntimeEventPublisher,
} from "@agent-anything/observability/events";
import type { ApprovalReviewerBinding } from "@agent-anything/agent-runtime/run";
import { Runner } from "@agent-anything/agent-runtime/runner";
import {
  createInMemoryHostPolicyAmendmentStore,
  createInMemoryHostSessionAuthorityStore,
  createHostRuntime,
  resolveHostRunContext,
  type HostActiveRun,
  type HostIdentityResolver,
  type HostIdentitySelection,
  type HostTerminalRunProjection,
  type HostWorkspaceResolver,
  type HostWorkspaceSelection,
  type UserApprovalReviewBridge,
} from "@agent-anything/host";
import {
  createCodeAgentCanonicalWorkspaceRoots,
} from "@agent-anything/helarc-code-agent/filesystem";
import type { CodeAgentCommandLimits } from "@agent-anything/helarc-code-agent/command";
import { EvidenceBuilder, type Evidence } from "@agent-anything/context/evidence";
import type {
  EvidencePersistencePort,
  EvidencePersistenceResult,
} from "@agent-anything/context/persistence";
import {
  createAllowAllActionPolicyPort,
  type PersistentPolicyAmendmentPort,
} from "@agent-anything/governance";
import {
  createHelarcContextProjector,
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
import type { Provider } from "@agent-anything/model-interaction";
import { listRunWorkspaces, type IdentityRef, type RunWorkspace, type WorkspaceContext } from "@agent-anything/agent-core/run";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type { RunInputItem } from "@agent-anything/agent-core/input";
import { createHelarcHostPermissionComposition } from "./HelarcHostPermissionComposition.js";

export interface PrepareHelarcHostRunInput {
  readonly sessionId: string;
  readonly productRunId: string;
  readonly task: AgentTask<HelarcTaskInput>;
  readonly conversationItems: readonly RunInputItem[];
  readonly workspaceResolver: HostWorkspaceResolver;
  readonly workspaceSelection: HostWorkspaceSelection;
  readonly identityResolver: HostIdentityResolver;
  readonly identitySelection: HostIdentitySelection;
  readonly provider: Provider;
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
  readonly evidencePersistence?: EvidencePersistencePort;
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
  readonly workspace: RunWorkspace;
  readonly identity: IdentityRef;
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
  const runWorkspace = runContext.workspace;
  const workspace = runWorkspace.primary;
  const workspaceRoots = resolvePermissionWorkspaceRoots(runWorkspace);
  const platform = workspaceRoots.some((root) => /^[A-Za-z]:[\\/]/.test(root.path))
    ? "win32" as const
    : "posix" as const;
  const enforcement = input.enforcement ?? "disabled";
  const sandboxProviders = input.sandboxProviders ?? [];
  assertSelectedSandboxProvider(enforcement, sandboxProviders);
  assertPatchReviewBridge(input.patchReviewBridge);

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
    userApprovalBridge: input.userApprovalBridge ?? null,
    automaticReviewer: input.automaticApprovalReviewer ?? null,
    sessionAuthorityPort: input.sessionAuthorityPort ??
      createInMemoryHostSessionAuthorityStore({ maxRecords: 64 }),
    persistentPolicyAmendments: input.persistentPolicyAmendments ??
      createInMemoryHostPolicyAmendmentStore({ maxRecords: 64 }),
  });
  const product = await createHelarcProductComposition({
    runId: input.productRunId,
    task: input.task,
    workspace: runWorkspace,
    provider: input.provider,
    toolMode: input.toolMode,
    commandLimits: input.commandLimits,
    patchReviewBridge: input.patchReviewBridge,
    now: input.now,
  });
  const actionEnforcementPipeline = new ActionEnforcementPipeline({
    registrations: product.actions.registrations,
    toolBindings: product.actions.toolBindings,
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
  const productRuntimeEventPublisher: RuntimeEventPublisher = Object.freeze({
    publish(event: RuntimeEvent) {
      product.recordRuntimeEvent(event);
    },
  });
  const runMetadata = Object.freeze({
    ...product.runMetadata,
    enforcement,
  });
  const runner = new Runner({
    controller: product.controller,
    contextProjection: {
      projector: createHelarcContextProjector(),
      purpose: "model",
      limits: {
        maxMessages: 32,
        maxMessageLength: 16_000,
        maxObservations: 32,
        maxObservationBytes: 64 * 1024,
        maxEvidenceRefs: 32,
        maxMetadataEntries: 1,
      },
    },
    actionEnforcementPipeline,
    sandboxExecutionGateway,
    evidenceBuilder: new EvidenceBuilder(),
    evidencePersistence:
      input.evidencePersistence ?? new InMemoryHelarcEvidencePersistence(input.now),
    runtimeEventPublisher: productRuntimeEventPublisher,
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
      toolBindingSnapshotId: product.actions.toolBindings.snapshotId,
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
      task: input.task,
      items: input.conversationItems,
      metadata: runMetadata,
    },
    runConfig: {
      workspace: runWorkspace,
      identity: runContext.identity,
      actionContext: {
        workspace: {
          workspaceId: workspace.id,
          trustState: workspace.trustState,
          roots: canonicalRoots,
        },
        actor: {
          identityId: runContext.identity.id,
          kind: runContext.identity.kind,
        },
        environment: {
          environmentId: permissions.permissions.permissionProfile.environmentId,
          platform,
          configurationFingerprint,
        },
      },
      permissions: permissions.permissions,
      toolBindings: product.actions.toolBindings,
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
    productRunId: input.productRunId,
    workspace: runWorkspace,
    identity: runContext.identity,
    start(): HelarcHostRunComposition {
      if (started) {
        throw new Error("Prepared Helarc Host Run can be started only once.");
      }
      started = true;
      const hostActiveRun = runtime.start(hostRunStartInput);
      input.patchReviewBridge.bindRun(hostActiveRun.runId);
      const activeRun = createHelarcHostActiveRun(
        hostActiveRun,
        input.patchReviewBridge,
        product.getProductProjection,
        product.subscribeProductProjection,
      );

      return Object.freeze({
        activeRun,
        result: activeRun.result.then((outcome): HelarcHostRunResult => {
          const productResult = product.projectResult(outcome.runResult, enforcement);
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

function createHelarcHostActiveRun(
  host: HostActiveRun<HelarcAgentOutput>,
  patchReviews: HelarcPatchReviewBridge,
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
    submitApprovalDecision: (input: Parameters<HostActiveRun["submitApprovalDecision"]>[0]) =>
      host.submitApprovalDecision(input),
    cancel: (input: Parameters<HostActiveRun["cancel"]>[0]) => host.cancel(input),
    getPatchReviewProjection: () => patchReviews.getPendingProjection(),
    getProductProjection,
    subscribeProductProjection,
    submitPatchReviewDecision(
      input: HelarcPatchReviewDecisionSubmission,
    ): HelarcPatchReviewSubmissionReceipt {
      return patchReviews.submitDecision(input);
    },
    result: host.result,
  });
}

function assertPatchReviewBridge(bridge: HelarcPatchReviewBridge): void {
  if (
    bridge === null ||
    typeof bridge !== "object" ||
    typeof bridge.review !== "function" ||
    typeof bridge.bindRun !== "function" ||
    typeof bridge.getPendingProjection !== "function" ||
    typeof bridge.subscribe !== "function" ||
    typeof bridge.submitDecision !== "function"
  ) {
    throw new TypeError("Helarc Host Run requires a Patch review bridge.");
  }
  if (bridge.boundRunId !== null) {
    throw new TypeError("Helarc patch review bridge must be unbound before Run start.");
  }
}

function resolvePermissionWorkspaceRoots(
  workspace: RunWorkspace,
): Array<{ rootId: string; path: string }> {
  const roots = listRunWorkspaces(workspace).map((candidate) => ({
    rootId: candidate.id,
    path: requireWorkspacePath(candidate),
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

class InMemoryHelarcEvidencePersistence implements EvidencePersistencePort {
  private readonly evidence = new Map<string, Evidence>();
  private nextId = 1;

  constructor(private readonly now: (() => string) | undefined) {}

  async persistEvidence(evidence: Evidence): Promise<EvidencePersistenceResult> {
    this.evidence.set(evidence.id, evidence);
    const storageId = `helarc_evidence_${this.nextId}`;
    this.nextId += 1;
    return {
      status: "stored",
      artifact: {
        storageId,
        evidenceRef: evidence.id,
        artifactRef: `memory://evidence/${evidence.id}`,
        createdAt: this.now?.() ?? new Date().toISOString(),
        metadata: {
          adapter: "helarc-in-memory",
          retention: "process",
        },
      },
    };
  }
}
