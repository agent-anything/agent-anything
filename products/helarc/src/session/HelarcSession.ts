import {
  ActionEnforcementPipeline,
  ProviderBackedController,
  createCanonicalSha256Digest,
  createSandboxExecutionGateway,
  createSystemRetryExecutor,
  Runner,
  RuntimeEventEmitter,
  RuntimeEventRecorder,
  systemRetryClock,
  createRunCancellationController,
  type Agent,
  type AgentTask,
  type RunCancellationController,
  type RunResult,
  type RunResultStatus,
  type RetryClock,
  type RuntimeEvent,
  type ApprovalReviewerBinding,
  type SandboxEnforcement,
  type SandboxProvider,
} from "@agent-anything/agent-core";
import {
  createAllowAllActionPolicyPort,
  type PersistentPolicyAmendmentPort,
  type WorkspaceContext,
} from "@agent-anything/governance";
import type { SessionAuthorityPort } from "@agent-anything/permission";
import {
  CODE_AGENT_RUN_COMMAND_ACTION,
  createCodeAgentCanonicalWorkspaceRoots,
  type CodeAgentShellLimits,
  type MaterializedPatchReview,
} from "@agent-anything/code-agent";
import {
  projectRuntimeEventForHost,
  type HostSessionId,
  type UserApprovalReviewBridge,
} from "@agent-anything/agent-core/host";
import { EvidenceBuilder, type Evidence } from "@agent-anything/evidence";
import type { Provider } from "@agent-anything/providers";
import type { ArtifactRef, ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { StoragePort, StoredArtifact } from "@agent-anything/storage";
import type { ToolDefinition } from "@agent-anything/tools";
import {
  buildHelarcProviderRequest,
  createHelarcToolCatalogMetadata,
  HELARC_CONTROLLER_OUTPUT_MAX_LENGTH,
  HELARC_ACTION_CONTRACT_VERSION,
  HELARC_TOOL_CATALOG_METADATA_KEY,
  parseHelarcProviderResponse,
  type HelarcAgentOutput,
  type HelarcChangeIntent,
} from "../controller/index.js";
import {
  enrichRuntimeEventWithControllerTrace,
  HelarcTracingController,
} from "../run/HelarcControllerTraceProjection.js";
import type { HelarcTaskInput } from "../task/index.js";
import {
  createHelarcPermissionComposition,
  type HelarcPermissionPreset,
} from "../permission/index.js";
import { createHelarcActionComposition } from "./HelarcActionComposition.js";
import { HelarcPatchActionController } from "./HelarcPatchActionController.js";

export type HelarcSessionStatus =
  | "running"
  | "completed"
  | "rejected"
  | "failed"
  | "blocked"
  | "cancelled";

export type HelarcPatchStatus = "proposed" | "applied" | "rejected" | "failed";

export interface HelarcActivityItem {
  id: string;
  sequence: number;
  timestamp: ISODateTimeString;
  kind: string;
  title: string;
  detail: string | null;
  metadata: Metadata;
}

export interface HelarcSessionOutput {
  taskId: string;
  workspaceId: string | null;
  agentSummary: string | null;
  runtimeStatus: RunResultStatus;
  patchStatus: HelarcPatchStatus | null;
  appliedPath: string | null;
  enforcement: HelarcEnforcementSummary;
  safeErrors: Array<{ code: string; message: string }>;
}

export interface HelarcEnforcementSummary {
  selected: SandboxEnforcement;
  status:
    | "not_exercised"
    | "unisolated"
    | "enforced"
    | "unavailable"
    | "denied"
    | "interrupted"
    | "failed";
  code: string | null;
}

export interface HelarcSessionResult {
  status: HelarcSessionStatus;
  runResult: RunResult<HelarcAgentOutput>;
  output: HelarcSessionOutput;
  activity: HelarcActivityItem[];
}

export interface RunHelarcReadOnlySessionInput {
  task: AgentTask<HelarcTaskInput>;
  provider: Provider;
  runId?: string;
  cancellation?: RunCancellationController;
  storage?: StoragePort;
  now?: () => ISODateTimeString;
  permissionPreset?: HelarcPermissionPreset;
  userApprovalBridge?: UserApprovalReviewBridge;
  automaticApprovalReviewer?: ApprovalReviewerBinding & {
    readonly kind: "auto_review";
  };
  sessionAuthorityPort?: SessionAuthorityPort;
  persistentPolicyAmendments?: PersistentPolicyAmendmentPort;
  enforcement?: SandboxEnforcement;
  sandboxProviders?: readonly SandboxProvider[];
}

export interface RunHelarcSessionInput extends RunHelarcReadOnlySessionInput {
  sessionId?: HostSessionId;
  enableShell?: boolean;
  shellLimits?: Partial<CodeAgentShellLimits>;
  patchReviewBridge?: HelarcPatchReviewBridge;
  onActivity?: (item: HelarcActivityItem, event: RuntimeEvent) => void;
}

export interface HelarcPatchReviewViewModel {
  patchId: string;
  rootName: string;
  workspaceId: string;
  path: string;
  operation: MaterializedPatchReview["operation"];
  summary: string;
  rationale: string;
  originalContent: string | null;
  proposedContent: string | null;
  originalContentBytes: number | null;
  proposedContentBytes: number | null;
  decisionState: "pending";
}

export type HelarcPatchReviewDecision =
  | { decision: "accepted"; reason?: string }
  | { decision: "rejected"; reason: string };

export type HelarcPatchReviewBridge = (
  review: HelarcPatchReviewViewModel,
) => Promise<HelarcPatchReviewDecision>;

export async function runHelarcReadOnlySession(
  input: RunHelarcReadOnlySessionInput,
): Promise<HelarcSessionResult> {
  return runHelarcSession({
    ...input,
    enableShell: false,
  });
}

export async function runHelarcSession(
  input: RunHelarcSessionInput,
): Promise<HelarcSessionResult> {
  const runId = input.runId ?? input.sessionId ?? input.task.id;
  const hostSessionId = input.sessionId ?? runId;
  const cancellation = input.cancellation ?? createRunCancellationController({ runId });
  const workspace = resolveHelarcRunWorkspace(input.task);
  const identity = {
    id: hostSessionId,
    kind: "anonymous" as const,
    displayName: "Helarc user",
    metadata: { product: "helarc" },
  };
  const workspaceRoots = resolvePermissionWorkspaceRoots(input.task);
  const platform = workspaceRoots.some((root) => /^[A-Za-z]:[\\/]/.test(root.path))
    ? "win32" as const
    : "posix" as const;
  const enforcement = input.enforcement ?? "disabled";
  const sandboxProviders = input.sandboxProviders ?? [];
  assertSelectedSandboxProvider(enforcement, sandboxProviders);
  const canonicalRoots = await createCodeAgentCanonicalWorkspaceRoots({
    workspaceScope: input.task.workspaceScope,
    platform,
  });
  const permissionComposition = await createHelarcPermissionComposition({
    preset: input.permissionPreset ?? "ask_for_approval",
    runId,
    hostSessionId,
    workspace,
    workspaceRoots: canonicalRoots.map((root) => ({
      rootId: root.rootId,
      path: root.resolvedPath,
    })),
    platform,
    enforcement,
    cancellation,
    userApprovalBridge: input.userApprovalBridge,
    automaticReviewer: input.automaticApprovalReviewer,
    sessionAuthorityPort: input.sessionAuthorityPort,
    persistentPolicyAmendments: input.persistentPolicyAmendments,
  });
  const retryClock = createHelarcRetryClock(input.now);
  const eventEmitter = new RuntimeEventEmitter();
  const recorder = new RuntimeEventRecorder();
  const controllerTraceByIteration = new Map<number, Metadata>();
  recorder.attachTo(eventEmitter);
  eventEmitter.subscribe((event) => {
    const tracedEvent = enrichRuntimeEventWithControllerTrace(
      event,
      controllerTraceByIteration,
    );
    input.onActivity?.(mapRuntimeEventToHelarcActivity(tracedEvent), tracedEvent);
  });

  const actionComposition = await createHelarcActionComposition(input.task, {
    enableShell: input.enableShell ?? false,
    shellLimits: input.shellLimits,
  });
  const evidenceBuilder = new EvidenceBuilder();
  const actionEnforcementPipeline = new ActionEnforcementPipeline({
    registrations: actionComposition.registrations,
    adapters: actionComposition.adapters,
    policyPort: createAllowAllActionPolicyPort(),
    now: input.now,
  });
  const sandboxExecutionGateway = createSandboxExecutionGateway({
    registrations: actionComposition.registrations,
    executors: actionComposition.executors,
    providers: sandboxProviders,
    limits: { maxResultBytes: 2 * 1024 * 1024 },
    now: input.now,
  });
  const providerController = new HelarcTracingController(new ProviderBackedController<HelarcAgentOutput>({
    provider: input.provider,
    buildRequest: buildHelarcProviderRequest,
    parseResponse: parseHelarcProviderResponse,
    structuredOutputContractId: HELARC_ACTION_CONTRACT_VERSION,
    maxProviderOutputLength: HELARC_CONTROLLER_OUTPUT_MAX_LENGTH,
    retryExecutor: createSystemRetryExecutor(retryClock),
    retryClock,
  }), controllerTraceByIteration);
  const controller = new HelarcPatchActionController({
    controller: providerController,
    patchReviewBridge: input.patchReviewBridge,
    now: input.now,
  });
  const sessionMode = input.enableShell ? "shell-enabled" : "read-only";
  const runMetadata = Object.freeze({
    product: "helarc",
    sessionMode,
    [HELARC_TOOL_CATALOG_METADATA_KEY]: createHelarcToolCatalogMetadata({
      mode: sessionMode,
      tools: actionComposition.exposedCatalog.tools,
    }),
    enforcement,
  });
  const evidenceStorage = input.storage ?? new InMemoryHelarcStorage(input.now);
  const runner = new Runner({
    controller,
    actionEnforcementPipeline,
    sandboxExecutionGateway,
    evidenceBuilder,
    evidenceStorage,
    eventEmitter,
    now: input.now,
  });
  const actionContext = {
    workspace: {
      workspaceId: workspace.id,
      trustState: workspace.trustState,
      roots: canonicalRoots,
    },
    actor: { identityId: identity.id, kind: identity.kind },
    environment: {
      environmentId: permissionComposition.permissions.permissionProfile.environmentId,
      platform,
      configurationFingerprint: await createCanonicalSha256Digest(
        "agent-anything.helarc.local-environment.v1",
        {
          platform,
          enforcement,
          registrationFingerprints: actionComposition.registrations.registrations.map(
            (registration) => registration.registrationFingerprint,
          ),
          workspaceRootFingerprints: canonicalRoots.map(
            (root) => root.resolutionFingerprint,
          ),
        },
      ),
    },
  } as const;
  const runResult = await runner.run(
    createHelarcAgent(actionComposition.agentTools),
    {
      runId,
      task: input.task,
      conversationItems: [],
      metadata: runMetadata,
    },
    {
      workspace,
      identity,
      actionContext,
      permissions: permissionComposition.permissions,
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
      cancellation,
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
          serverDelay: {
            mode: "prefer_trusted",
            maxServerDelayMs: 10_000,
          },
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
  );
  const activity = recorder.events()
    .map((event) => mapRuntimeEventToHelarcActivity(
      enrichRuntimeEventWithControllerTrace(event, controllerTraceByIteration),
    ));
  const patchOutcome = controller.getPatchOutcome();
  const output = createSessionOutput(input.task, runResult, patchOutcome, enforcement);

  return {
    status: patchOutcome?.sessionStatus ?? mapRunStatus(runResult.status),
    runResult,
    output,
    activity,
  };
}

function createHelarcRetryClock(
  now: RunHelarcSessionInput["now"],
): RetryClock {
  if (now === undefined) {
    return systemRetryClock;
  }

  return Object.freeze({
    now: () => new Date(now()),
  });
}

function createHelarcAgent(
  tools: readonly ToolDefinition[],
): Agent<HelarcAgentOutput> {
  return Object.freeze({
    id: "helarc-code-agent",
    name: "Helarc",
    instructions: "Complete the requested code task within the active workspace and safety boundaries.",
    tools: Object.freeze([...tools]),
    output: Object.freeze({
      validate(candidate: unknown) {
        if (!isRecord(candidate) || typeof candidate.summary !== "string") {
          return { valid: false as const, message: "Helarc output requires a summary." };
        }
        if (candidate.kind === "complete") {
          return {
            valid: true as const,
            output: Object.freeze({ kind: "complete" as const, summary: candidate.summary }),
          };
        }
        if (candidate.kind !== "propose" || !isRecord(candidate.change)) {
          return { valid: false as const, message: "Helarc output kind is invalid." };
        }
        const operation = candidate.change.operation;
        const path = candidate.change.path;
        const content = candidate.change.content;
        if (
          (operation !== "create" && operation !== "update" && operation !== "delete") ||
          typeof path !== "string" ||
          ((operation === "create" || operation === "update") && typeof content !== "string")
        ) {
          return { valid: false as const, message: "Helarc proposed change is invalid." };
        }
        const change: HelarcChangeIntent = operation === "delete"
          ? { operation, path }
          : { operation, path, content: content as string };
        return {
          valid: true as const,
          output: Object.freeze({
            kind: "propose" as const,
            summary: candidate.summary,
            change: Object.freeze(change),
          }),
        };
      },
    }),
    metadata: Object.freeze({ product: "helarc" }),
  });
}

function resolveHelarcRunWorkspace(task: AgentTask) {
  const scope = task.workspaceScope;
  if (!scope) {
    throw new TypeError("Helarc requires a task workspace scope.");
  }
  if (scope.defaultRootName !== undefined) {
    const workspace = scope.roots[scope.defaultRootName];
    if (workspace) {
      return workspace;
    }
  }
  const workspaces = Object.values(scope.roots);
  if (workspaces.length === 1 && workspaces[0]) {
    return workspaces[0];
  }
  throw new TypeError("Helarc requires one resolvable default workspace.");
}

function resolvePermissionWorkspaceRoots(
  task: AgentTask,
): Array<{ rootId: string; path: string }> {
  const scope = task.workspaceScope;
  if (!scope) {
    throw new TypeError("Helarc requires workspace roots for permission resolution.");
  }
  const workspaceRoots = Object.entries(scope.roots).map(([rootName, workspace]) => ({
    rootId: workspace.id || rootName,
    path: requireWorkspacePath(workspace),
  }));
  if (workspaceRoots.length === 0) {
    throw new TypeError("Helarc requires at least one permission workspace root.");
  }
  return workspaceRoots;
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

export function mapRuntimeEventToHelarcActivity(
  event: RuntimeEvent,
): HelarcActivityItem {
  const projectedEvent = projectRuntimeEventForHost(event);
  const payload = isRecord(projectedEvent.payload) ? projectedEvent.payload : {};
  return {
    id: projectedEvent.id,
    sequence: projectedEvent.sequence,
    timestamp: projectedEvent.timestamp,
    kind: projectedEvent.name,
    title: titleForEvent(projectedEvent.name, payload),
    detail: detailForEvent(projectedEvent.name, payload),
    metadata: payload,
  };
}

function createSessionOutput(
  task: AgentTask,
  runResult: RunResult<HelarcAgentOutput>,
  patchOutcome: ReturnType<HelarcPatchActionController["getPatchOutcome"]>,
  selectedEnforcement: SandboxEnforcement,
): HelarcSessionOutput {
  const agentOutput = runResult.status === "succeeded" ? runResult.finalOutput : null;
  const safeErrors = collectSafeRunErrors(runResult);
  for (const error of patchOutcome?.errors ?? []) {
    appendSafeError(safeErrors, error.code, error.message);
  }
  return {
    taskId: task.id,
    workspaceId: task.workspaceScope?.roots[task.workspaceScope.defaultRootName ?? ""]?.id ?? null,
    agentSummary: agentOutput?.summary ?? null,
    runtimeStatus: runResult.status,
    patchStatus: patchOutcome?.patchStatus ?? null,
    appliedPath: patchOutcome?.appliedPath ?? null,
    enforcement: createEnforcementSummary(runResult, selectedEnforcement),
    safeErrors,
  };
}

function createEnforcementSummary(
  runResult: RunResult<HelarcAgentOutput>,
  selected: SandboxEnforcement,
): HelarcEnforcementSummary {
  const item = [...runResult.items].reverse().find(
    (candidate) => candidate.kind === "sandbox_attempt_resolved",
  );
  if (item?.kind !== "sandbox_attempt_resolved") {
    return { selected, status: "not_exercised", code: null };
  }
  const resolution = item.resolution;
  const status: HelarcEnforcementSummary["status"] = resolution.outcome === "executed"
    ? resolution.enforcement === "disabled" ? "unisolated" : "enforced"
    : resolution.outcome === "sandbox_unavailable"
      ? "unavailable"
      : resolution.outcome === "sandbox_denied"
        ? "denied"
        : resolution.outcome;
  return {
    selected,
    status,
    code: status === "unisolated" || status === "enforced" ? null : resolution.code,
  };
}

function collectSafeRunErrors(
  runResult: RunResult<HelarcAgentOutput>,
): Array<{ code: string; message: string }> {
  const errors = runResult.errors.map((error) => ({
      code: error.code,
      message: error.message,
    }));
  for (const item of runResult.items) {
    if (item.kind !== "observation") {
      continue;
    }
    const observation = item.observation;
    if (observation.kind === "action_denied" || observation.kind === "action_rejected") {
      appendSafeError(errors, observation.code, observation.message);
    } else if (observation.kind === "action_failure") {
      appendSafeError(errors, observation.error.code, observation.error.message);
    }
  }
  return errors;
}

function appendSafeError(
  errors: Array<{ code: string; message: string }>,
  code: string,
  message: string,
): void {
  if (!errors.some((error) => error.code === code && error.message === message)) {
    errors.push({ code, message });
  }
}

function mapRunStatus(status: RunResultStatus): HelarcSessionStatus {
  if (status === "succeeded") {
    return "completed";
  }

  return status;
}

function titleForEvent(name: string, payload: Metadata): string {
  switch (name) {
    case "run.started":
      return "Run started";
    case "run.completed":
      return "Run completed";
    case "run.blocked":
      return "Run blocked";
    case "run.failed":
      return "Run failed";
    case "run.cancelled":
      return "Run cancelled";
    case "controller.started":
      return `Controller iteration ${payload.iteration ?? ""} started`.trim();
    case "controller.finished":
      return `Controller ${payload.status ?? "finished"}`;
    case "run.item.appended":
      return `Run item appended: ${payload.itemKind ?? "unknown"}`;
    case "approval.requested":
      return `Approval requested: ${payload.category ?? "action"}`;
    case "approval.resolved":
      return `Approval ${payload.decisionKind ?? payload.resolutionKind ?? "resolved"}`;
    case "tool.started":
      return `Tool started: ${payload.toolName ?? "unknown"}`;
    case "tool.finished":
      return `Tool ${payload.status ?? "finished"}: ${payload.toolName ?? "unknown"}`;
    case "action.prepared":
      return "Action prepared";
    case "action.assessed":
      return `Action ${payload.status ?? "assessed"}`;
    case "action.invalidated":
      return "Action invalidated";
    case "sandbox.attempt.started":
      return payload.enforcement === "disabled"
        ? "Unisolated execution started"
        : `${payload.enforcement ?? "Sandbox"} enforcement started`;
    case "sandbox.attempt.resolved":
      return payload.enforcement === "disabled" && payload.outcome === "executed"
        ? "Unisolated execution completed"
        : `${payload.enforcement ?? "Sandbox"} enforcement ${payload.outcome ?? "resolved"}`;
    case "sandbox.escalation.proposed":
      return "Sandbox escalation proposed";
    case "retry.attempt.started":
      return `Retry attempt ${payload.attemptNumber ?? ""} started`.trim();
    case "retry.attempt.finished":
      return `Retry attempt ${payload.attemptNumber ?? ""} ${payload.outcome ?? "finished"}`.trim();
    case "retry.scheduled":
      return `Retry ${payload.nextAttemptNumber ?? ""} scheduled`.trim();
    case "retry.exhausted":
      return "Retry exhausted";
    case "retry.cancelled":
      return "Retry cancelled";
    case "retry.fallback.selected":
      return "Retry fallback selected";
    default:
      return name;
  }
}

function detailForEvent(name: string, payload: Metadata): string | null {
  if (
    (name === "tool.started" || name === "tool.finished")
    && payload.toolName === CODE_AGENT_RUN_COMMAND_ACTION
    && typeof payload.command === "string"
  ) {
    return payload.command;
  }

  if (name === "tool.started" || name === "tool.finished") {
    return typeof payload.actionId === "string" ? payload.actionId : null;
  }

  if (name.startsWith("action.") || name.startsWith("sandbox.")) {
    return typeof payload.actionId === "string"
      ? payload.actionId
      : typeof payload.attemptId === "string" ? payload.attemptId : null;
  }

  if (name === "controller.finished") {
    return typeof payload.controllerAction === "string"
      ? payload.controllerAction
      : null;
  }

  if (name === "approval.requested" || name === "approval.resolved") {
    return typeof payload.requestId === "string" ? payload.requestId : null;
  }

  if (name.startsWith("retry.")) {
    return typeof payload.operationId === "string" ? payload.operationId : null;
  }

  return null;
}

function isRecord(value: unknown): value is Metadata {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class InMemoryHelarcStorage implements StoragePort {
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
      metadata: {
        evidenceId: evidence.id,
      },
    };
  }
}
