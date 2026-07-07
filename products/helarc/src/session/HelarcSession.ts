import {
  AgentLoop,
  AgentRuntime,
  InMemoryContextManager,
  ProviderBackedPlanner,
  RuntimeEventEmitter,
  RuntimeEventRecorder,
  ToolExecutionBoundary,
  type AgentTask,
  type RuntimeEvent,
  type RuntimeResult,
  type RuntimeStatus,
} from "@agent-anything/agent-core";
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
import { ToolRegistry } from "@agent-anything/tools";
import {
  buildHelarcProviderRequest,
  createHelarcToolCatalogMetadata,
  HELARC_TOOL_CATALOG_METADATA_KEY,
  parseHelarcProviderResponse,
  type HelarcAgentOutput,
  type HelarcChangeIntent,
} from "../planner/index.js";
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
  runtimeStatus: RuntimeStatus;
  patchStatus: HelarcPatchStatus | null;
  appliedPath: string | null;
  safeErrors: Array<{ code: string; message: string }>;
}

export interface HelarcSessionResult {
  status: HelarcSessionStatus;
  runtimeResult: RuntimeResult<HelarcAgentOutput>;
  output: HelarcSessionOutput;
  activity: HelarcActivityItem[];
}

export interface RunHelarcReadOnlySessionInput {
  task: AgentTask<HelarcTaskInput>;
  provider: Provider;
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
  recorder.attachTo(eventEmitter);
  eventEmitter.subscribe((event) => {
    input.onActivity?.(mapRuntimeEventToHelarcActivity(event), event);
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
  const planner = new ProviderBackedPlanner({
    provider: input.provider,
    buildRequest: buildHelarcProviderRequest,
    parseResponse: parseHelarcProviderResponse,
  });
  const loop = new AgentLoop({
    planner,
    contextManager: new InMemoryContextManager(),
    toolExecutionBoundary,
    eventEmitter,
  });
  const runtime = new AgentRuntime(
    {
      toolRegistry: registryResult.registry,
      evidenceBuilder,
      storage: input.storage ?? new InMemoryHelarcStorage(input.now),
      planToolCalls: () => [],
      agentLoop: loop,
    },
    {
      limits: {
        maxToolCalls: 5,
        maxDurationMs: 30000,
        maxConsecutiveFailures: 1,
        maxIterations: 5,
      },
      permissionMode: input.enableShell ? "ask" : "trusted",
      executionAccess: "workspace",
      outputSpec: { format: "json", metadata: { product: "helarc" } },
      metadata: {
        product: "helarc",
        sessionMode: input.enableShell ? "shell" : "read-only",
        [HELARC_TOOL_CATALOG_METADATA_KEY]: createHelarcToolCatalogMetadata({
          mode: input.enableShell ? "shell-enabled" : "read-only",
          tools: registryResult.registry.list(),
        }),
      },
    },
  );

  const runtimeResult = await runtime.run(input.task) as RuntimeResult<HelarcAgentOutput>;
  const activity = recorder.events().map(mapRuntimeEventToHelarcActivity);
  const patchOutcome = await resolvePatchOutcome(input, runtimeResult);
  const output = createSessionOutput(input.task, runtimeResult, patchOutcome);

  return {
    status: patchOutcome?.sessionStatus ?? mapRuntimeStatus(runtimeResult.status),
    runtimeResult,
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
  runtimeResult: RuntimeResult<HelarcAgentOutput>,
): Promise<HelarcPatchOutcome | null> {
  if (runtimeResult.status !== "succeeded" || runtimeResult.output?.kind !== "propose") {
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
    const proposed = await createHelarcPatchProposal(input, runtimeResult.output);
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
  runtimeResult: RuntimeResult<HelarcAgentOutput>,
  patchOutcome: HelarcPatchOutcome | null,
): HelarcSessionOutput {
  const agentOutput = runtimeResult.output;
  const safeErrors: Array<{ code: string; message: string }> =
    runtimeResult.errors.map((error) => ({
      code: error.code,
      message: error.message,
    }));
  return {
    taskId: task.id,
    workspaceId: task.workspaceScope?.roots[task.workspaceScope.defaultRootName ?? ""]?.id ?? null,
    agentSummary: agentOutput?.summary ?? null,
    runtimeStatus: runtimeResult.status,
    patchStatus: patchOutcome?.patchStatus ?? null,
    appliedPath: patchOutcome?.appliedPath ?? null,
    safeErrors: safeErrors.concat(patchOutcome?.errors ?? []),
  };
}

function mapRuntimeStatus(status: RuntimeStatus): HelarcSessionStatus {
  if (status === "succeeded") {
    return "completed";
  }

  return status;
}

function titleForEvent(name: string, payload: Metadata): string {
  switch (name) {
    case "loop.iteration.started":
      return `Iteration ${payload.iteration ?? ""}`.trim();
    case "planner.started":
      return "Planner started";
    case "planner.finished":
      return `Planner ${payload.status ?? "finished"}`;
    case "plan.created":
      return `Plan ${payload.planStepKind ?? "created"}`;
    case "tool.started":
      return `Tool started: ${payload.toolName ?? "unknown"}`;
    case "tool.finished":
      return `Tool ${payload.status ?? "finished"}: ${payload.toolName ?? "unknown"}`;
    case "observation.created":
      return "Observation created";
    case "context.updated":
      return "Context updated";
    case "loop.iteration.finished":
      return `Iteration ${payload.status ?? "finished"}`;
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
    return typeof payload.toolCallId === "string" ? payload.toolCallId : null;
  }

  if (name === "plan.created") {
    return typeof payload.planStepId === "string" ? payload.planStepId : null;
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
