import {
  ProviderBackedController,
  Runner,
  RuntimeEventEmitter,
  RuntimeEventRecorder,
  ToolExecutionBoundary,
  createRunCancellationController,
  type Agent,
  type AgentTask,
  type RunCancellationController,
  type RunResult,
  type RunResultStatus,
  type RuntimeEvent,
} from "@agent-anything/agent-core";
import { TemporaryToolActionBridge } from "@agent-anything/agent-core/runtime";
import {
  acceptPatch,
  applyAcceptedPatch,
  createCodeAgentFileTools,
  createPatchProposal,
  materializePatchReview,
  PatchWorkflowError,
  rejectPatch,
  registerCodeAgentShellTool,
  type CodeAgentShellLimits,
  type MaterializedPatchReview,
  type PatchProposalChange,
  type ProposedPatchStatus,
} from "@agent-anything/code-agent";
import {
  CODE_AGENT_LIST_FILES_TOOL,
  CODE_AGENT_RUN_COMMAND_TOOL,
  CODE_AGENT_READ_FILE_TOOL,
  CODE_AGENT_SEARCH_FILES_TOOL,
} from "@agent-anything/code-agent";
import {
  createHostPermissionService,
  type HostEventSink,
  type HostPermissionBridge,
  type HostSessionId,
} from "@agent-anything/agent-core/host";
import { EvidenceBuilder, type Evidence } from "@agent-anything/evidence";
import type { Provider } from "@agent-anything/providers";
import type { ArtifactRef, ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { StoragePort, StoredArtifact } from "@agent-anything/storage";
import { ToolRegistry, type ToolDefinition } from "@agent-anything/tools";
import {
  buildHelarcProviderRequest,
  createHelarcToolCatalogMetadata,
  HELARC_CONTROLLER_OUTPUT_MAX_LENGTH,
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
  safeErrors: Array<{ code: string; message: string }>;
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
}

export interface RunHelarcSessionInput extends RunHelarcReadOnlySessionInput {
  sessionId?: HostSessionId;
  enableShell?: boolean;
  shellLimits?: Partial<CodeAgentShellLimits>;
  permissionBridge?: HostPermissionBridge;
  hostEventSink?: HostEventSink;
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

  const registryResult = createHelarcToolRegistry(input.task, {
    enableShell: input.enableShell ?? false,
    shellLimits: input.shellLimits,
  });
  const evidenceBuilder = new EvidenceBuilder();
  const toolExecutionBoundary = new ToolExecutionBoundary({
    toolRegistry: registryResult.registry,
    evidenceBuilder,
    permissionService: input.enableShell && input.permissionBridge
      ? createHostPermissionService({
          sessionId: input.sessionId ?? input.task.id,
          bridge: input.permissionBridge,
          eventSink: input.hostEventSink,
        })
      : undefined,
    toolExecutionContextResolver: registryResult.toolExecutionContextResolver,
  });
  const controller = new HelarcTracingController(new ProviderBackedController<HelarcAgentOutput>({
    provider: input.provider,
    buildRequest: buildHelarcProviderRequest,
    parseResponse: parseHelarcProviderResponse,
    maxProviderOutputLength: HELARC_CONTROLLER_OUTPUT_MAX_LENGTH,
  }), controllerTraceByIteration);
  const sessionMode = input.enableShell ? "shell-enabled" : "read-only";
  const runMetadata = Object.freeze({
    product: "helarc",
    sessionMode,
    [HELARC_TOOL_CATALOG_METADATA_KEY]: createHelarcToolCatalogMetadata({
      mode: sessionMode,
      tools: registryResult.registry.list(),
    }),
  });
  const toolActionBridge = new TemporaryToolActionBridge({
    boundary: toolExecutionBoundary,
    storage: input.storage ?? new InMemoryHelarcStorage(input.now),
    permissionMode: input.enableShell ? "ask" : "trusted",
  });
  const runner = new Runner({
    controller,
    toolActionBridge,
    eventEmitter,
    now: input.now,
  });
  const runId = input.runId ?? input.sessionId ?? input.task.id;
  const cancellation = input.cancellation ?? createRunCancellationController({ runId });
  const runResult = await runner.run(
    createHelarcAgent(registryResult.registry.list()),
    {
      runId,
      task: input.task,
      conversationItems: [],
      metadata: runMetadata,
    },
    {
      workspace: resolveHelarcRunWorkspace(input.task),
      identity: {
        id: input.sessionId ?? runId,
        kind: "anonymous",
        displayName: "Helarc user",
        metadata: { product: "helarc" },
      },
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
        boundarySettlementTimeoutMs: 10_000,
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
          retryableCategories: ["transport", "timeout"],
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
          retryableCategories: ["structured_output_invalid"],
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
  const patchOutcome = await resolvePatchOutcome(input, runResult);
  const output = createSessionOutput(input.task, runResult, patchOutcome);

  return {
    status: patchOutcome?.sessionStatus ?? mapRunStatus(runResult.status),
    runResult,
    output,
    activity,
  };
}

export function createHelarcToolRegistry(
  task: AgentTask,
  input: {
    enableShell?: boolean;
    shellLimits?: Partial<CodeAgentShellLimits>;
  } = {},
): {
  registry: ToolRegistry;
  toolExecutionContextResolver?: ReturnType<typeof registerCodeAgentShellTool>;
} {
  const registry = createHelarcReadOnlyToolRegistry(task);
  if (!input.enableShell) {
    return { registry };
  }

  const toolExecutionContextResolver = registerCodeAgentShellTool(registry, {
    workspaceScope: task.workspaceScope,
    limits: input.shellLimits,
  });

  return {
    registry,
    toolExecutionContextResolver,
  };
}

export function createHelarcReadOnlyToolRegistry(
  task: AgentTask,
): ToolRegistry {
  const registry = new ToolRegistry();
  const allowedTools = new Set([
    CODE_AGENT_LIST_FILES_TOOL,
    CODE_AGENT_READ_FILE_TOOL,
    CODE_AGENT_SEARCH_FILES_TOOL,
  ]);

  for (const tool of createCodeAgentFileTools({ workspaceScope: task.workspaceScope })) {
    if (allowedTools.has(tool.name)) {
      registry.register(tool);
    }
  }

  return registry;
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

export function mapRuntimeEventToHelarcActivity(
  event: RuntimeEvent,
): HelarcActivityItem {
  const payload = isRecord(event.payload) ? event.payload : {};
  return {
    id: event.id,
    sequence: event.sequence,
    timestamp: event.timestamp,
    kind: event.name,
    title: titleForEvent(event.name, payload),
    detail: detailForEvent(event.name, payload),
    metadata: payload,
  };
}

interface HelarcPatchOutcome {
  sessionStatus: HelarcSessionStatus;
  patchStatus: HelarcPatchStatus;
  appliedPath: string | null;
  errors: Array<{ code: string; message: string }>;
}

async function resolvePatchOutcome(
  input: RunHelarcSessionInput,
  runResult: RunResult<HelarcAgentOutput>,
): Promise<HelarcPatchOutcome | null> {
  if (runResult.status !== "succeeded" || runResult.finalOutput.kind !== "propose") {
    return null;
  }

  if (!input.patchReviewBridge) {
    return {
      sessionStatus: "blocked",
      patchStatus: "proposed",
      appliedPath: null,
      errors: [{
        code: "patch_review_unavailable",
        message: "Patch review bridge is unavailable.",
      }],
    };
  }

  try {
    const proposed = await createHelarcPatchProposal(input, runResult.finalOutput);
    const review = toHelarcPatchReviewViewModel(await materializePatchReview({
      patch: proposed,
      workspaceScope: input.task.workspaceScope,
    }));
    const decision = await input.patchReviewBridge(review);

    if (decision.decision === "rejected") {
      rejectPatch(proposed, {
        reason: decision.reason,
        now: input.now,
      });
      return {
        sessionStatus: "rejected",
        patchStatus: "rejected",
        appliedPath: null,
        errors: [],
      };
    }

    const accepted = acceptPatch(proposed, {
      reason: decision.reason,
      now: input.now,
    });
    const applied = await applyAcceptedPatch({
      patch: accepted,
      workspaceScope: input.task.workspaceScope,
      now: input.now,
    });

    if (applied.status === "failed") {
      return {
        sessionStatus: "failed",
        patchStatus: "failed",
        appliedPath: null,
        errors: [{ code: applied.result.code, message: applied.result.message }],
      };
    }

    return {
      sessionStatus: "completed",
      patchStatus: "applied",
      appliedPath: applied.proposal.operation.path,
      errors: [],
    };
  } catch (error) {
    return {
      sessionStatus: "failed",
      patchStatus: "failed",
      appliedPath: null,
      errors: [{
        code: error instanceof PatchWorkflowError ? error.code : "patch_apply_failed",
        message: error instanceof Error ? error.message : "Patch workflow failed.",
      }],
    };
  }
}

function createHelarcPatchProposal(
  input: RunHelarcSessionInput,
  output: Extract<HelarcAgentOutput, { kind: "propose" }>,
): Promise<ProposedPatchStatus> {
  return createPatchProposal({
    workspaceScope: input.task.workspaceScope,
    change: toPatchProposalChange(output.change),
    summary: output.summary,
    rationale: output.summary,
    metadata: { product: "helarc" },
  }, {
    now: input.now,
  });
}

function toPatchProposalChange(change: HelarcChangeIntent): PatchProposalChange {
  if (change.operation === "delete") {
    return { kind: "delete", path: change.path };
  }

  return {
    kind: change.operation,
    path: change.path,
    proposedContent: change.content ?? "",
  };
}

function toHelarcPatchReviewViewModel(
  review: MaterializedPatchReview,
): HelarcPatchReviewViewModel {
  return {
    patchId: review.patchId,
    rootName: review.rootName,
    workspaceId: review.workspaceId,
    path: review.path,
    operation: review.operation,
    summary: review.summary,
    rationale: review.rationale,
    originalContent: review.originalContent,
    proposedContent: review.proposedContent,
    originalContentBytes: review.originalContentBytes,
    proposedContentBytes: review.proposedContentBytes,
    decisionState: "pending",
  };
}

function createSessionOutput(
  task: AgentTask,
  runResult: RunResult<HelarcAgentOutput>,
  patchOutcome: HelarcPatchOutcome | null,
): HelarcSessionOutput {
  const agentOutput = runResult.status === "succeeded" ? runResult.finalOutput : null;
  const safeErrors = collectSafeRunErrors(runResult);
  return {
    taskId: task.id,
    workspaceId: task.workspaceScope?.roots[task.workspaceScope.defaultRootName ?? ""]?.id ?? null,
    agentSummary: agentOutput?.summary ?? null,
    runtimeStatus: runResult.status,
    patchStatus: patchOutcome?.patchStatus ?? null,
    appliedPath: patchOutcome?.appliedPath ?? null,
    safeErrors: safeErrors.concat(patchOutcome?.errors ?? []),
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
    case "tool.started":
      return `Tool started: ${payload.toolName ?? "unknown"}`;
    case "tool.finished":
      return `Tool ${payload.status ?? "finished"}: ${payload.toolName ?? "unknown"}`;
    default:
      return name;
  }
}

function detailForEvent(name: string, payload: Metadata): string | null {
  if (
    (name === "tool.started" || name === "tool.finished")
    && payload.toolName === CODE_AGENT_RUN_COMMAND_TOOL
    && typeof payload.command === "string"
  ) {
    return payload.command;
  }

  if (name === "tool.started" || name === "tool.finished") {
    return typeof payload.actionId === "string" ? payload.actionId : null;
  }

  if (name === "controller.finished") {
    return typeof payload.controllerAction === "string"
      ? payload.controllerAction
      : null;
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
