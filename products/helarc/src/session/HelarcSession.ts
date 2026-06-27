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
import { createCodeAgentFileTools } from "@agent-anything/code-agent";
import {
  CODE_AGENT_LIST_FILES_TOOL,
  CODE_AGENT_READ_FILE_TOOL,
  CODE_AGENT_SEARCH_FILES_TOOL,
} from "@agent-anything/code-agent";
import { EvidenceBuilder, type Evidence } from "@agent-anything/evidence";
import type { Provider } from "@agent-anything/providers";
import type { ArtifactRef, ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { StoragePort, StoredArtifact } from "@agent-anything/storage";
import { ToolRegistry } from "@agent-anything/tools";
import {
  buildHelarcProviderRequest,
  parseHelarcProviderResponse,
  type HelarcAgentOutput,
} from "../planner/index.js";
import type { HelarcTaskInput } from "../task/index.js";

export type HelarcSessionStatus =
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

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
  patchStatus: null;
  appliedPath: null;
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

export async function runHelarcReadOnlySession(
  input: RunHelarcReadOnlySessionInput,
): Promise<HelarcSessionResult> {
  const eventEmitter = new RuntimeEventEmitter();
  const recorder = new RuntimeEventRecorder();
  recorder.attachTo(eventEmitter);

  const registry = createHelarcReadOnlyToolRegistry(input.task);
  const evidenceBuilder = new EvidenceBuilder();
  const toolExecutionBoundary = new ToolExecutionBoundary({
    toolRegistry: registry,
    evidenceBuilder,
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
      toolRegistry: registry,
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
      permissionMode: "trusted",
      executionAccess: "workspace",
      outputSpec: { format: "json", metadata: { product: "helarc" } },
      metadata: { product: "helarc", sessionMode: "read-only" },
    },
  );

  const runtimeResult = await runtime.run(input.task) as RuntimeResult<HelarcAgentOutput>;
  const activity = recorder.events().map(mapRuntimeEventToHelarcActivity);
  const output = createSessionOutput(input.task, runtimeResult);

  return {
    status: mapRuntimeStatus(runtimeResult.status),
    runtimeResult,
    output,
    activity,
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

function createSessionOutput(
  task: AgentTask,
  runtimeResult: RuntimeResult<HelarcAgentOutput>,
): HelarcSessionOutput {
  const agentOutput = runtimeResult.output;
  return {
    taskId: task.id,
    workspaceId: task.workspaceScope?.roots[task.workspaceScope.defaultRootName ?? ""]?.id ?? null,
    agentSummary: agentOutput?.summary ?? null,
    runtimeStatus: runtimeResult.status,
    patchStatus: null,
    appliedPath: null,
    safeErrors: runtimeResult.errors.map((error) => ({
      code: error.code,
      message: error.message,
    })),
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
