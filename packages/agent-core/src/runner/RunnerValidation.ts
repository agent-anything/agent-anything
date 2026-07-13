import type { Agent } from "../agent/index.js";
import type { ControllerDecision } from "../controller/index.js";
import type { WorkspaceContext } from "@agent-anything/governance";
import { assertValidPlanLimits } from "../plan/index.js";
import type { Metadata } from "@agent-anything/shared";
import type { RunConfig } from "./RunConfig.js";
import type { RunInput, RunInputItem } from "./RunInput.js";
import type { RuntimeError } from "./RuntimeError.js";

export interface ConfigValidationFailure {
  readonly valid: false;
  readonly error: RuntimeError & { readonly code: "runtime_invalid_options" };
}

export interface ConfigValidationSuccess {
  readonly valid: true;
  readonly config: RunConfig;
}

export function snapshotAgent<TOutput>(agent: Agent<TOutput>): Agent<TOutput> {
  if (!isRecord(agent)) {
    throw new TypeError("Agent must be an object.");
  }
  assertNonEmpty(agent.id, "Agent.id");
  assertNonEmpty(agent.name, "Agent.name");
  if (typeof agent.instructions !== "string") {
    throw new TypeError("Agent.instructions must be text.");
  }
  if (!Array.isArray(agent.tools)) {
    throw new TypeError("Agent.tools must be an array.");
  }
  if (!agent.output || typeof agent.output.validate !== "function") {
    throw new TypeError("Agent.output must provide validate().");
  }
  assertMetadata(agent.metadata, "Agent.metadata");

  return Object.freeze({
    ...agent,
    tools: Object.freeze([...agent.tools]),
    metadata: Object.freeze({ ...agent.metadata }),
  });
}

export function snapshotRunInput(input: RunInput): RunInput {
  if (!isRecord(input)) {
    throw new TypeError("RunInput must be an object.");
  }
  assertNonEmpty(input.runId, "RunInput.runId");
  if (!isRecord(input.task)) {
    throw new TypeError("RunInput.task must be an AgentTask.");
  }
  assertNonEmpty(input.task.id, "RunInput.task.id");
  assertNonEmpty(input.task.kind, "RunInput.task.kind");
  assertDateTime(input.task.createdAt, "RunInput.task.createdAt");
  assertMetadata(input.task.metadata, "RunInput.task.metadata");
  if (!Array.isArray(input.conversationItems)) {
    throw new TypeError("RunInput.conversationItems must be an array.");
  }
  assertMetadata(input.metadata, "RunInput.metadata");

  const ids = new Set<string>();
  const conversationItems = input.conversationItems.map((item, index) =>
    snapshotConversationItem(item, index, ids));
  const workspaceScope = input.task.workspaceScope === undefined
    ? undefined
    : snapshotWorkspaceScope(input.task.workspaceScope);
  const task = Object.freeze({
    ...input.task,
    ...(workspaceScope === undefined ? {} : { workspaceScope }),
    metadata: Object.freeze({ ...input.task.metadata }),
  });

  return Object.freeze({
    runId: input.runId,
    task,
    conversationItems: Object.freeze(conversationItems),
    metadata: Object.freeze({ ...input.metadata }),
  });
}

export function snapshotRunConfig(
  config: RunConfig,
  runId: string,
): ConfigValidationSuccess | ConfigValidationFailure {
  try {
    if (!isRecord(config)) {
      throw new TypeError("RunConfig must be an object.");
    }
    const workspace = snapshotWorkspaceContext(config.workspace, "RunConfig.workspace");

    if (!isRecord(config.identity)) {
      throw new TypeError("RunConfig.identity must be an IdentityRef.");
    }
    assertNonEmpty(config.identity.id, "RunConfig.identity.id");
    if (
      config.identity.kind !== "user" &&
      config.identity.kind !== "service" &&
      config.identity.kind !== "anonymous"
    ) {
      throw new TypeError("RunConfig.identity.kind is unsupported.");
    }
    assertNonEmpty(config.identity.displayName, "RunConfig.identity.displayName");
    assertMetadata(config.identity.metadata, "RunConfig.identity.metadata");

    if (!isRecord(config.limits)) {
      throw new TypeError("RunConfig.limits must be a RunLimits object.");
    }
    assertPositiveInteger(config.limits.maxIterations, "RunLimits.maxIterations");
    assertNonNegativeInteger(config.limits.maxActions, "RunLimits.maxActions");
    assertNonNegativeInteger(
      config.limits.maxConsecutiveActionFailures,
      "RunLimits.maxConsecutiveActionFailures",
    );
    assertPositiveInteger(config.limits.maxDurationMs, "RunLimits.maxDurationMs");
    assertValidPlanLimits(config.limits.plan);
    assertRequirement(config.audit, "RunConfig.audit");
    assertRequirement(config.telemetry, "RunConfig.telemetry");
    if (
      !config.cancellation ||
      !config.cancellation.context ||
      typeof config.cancellation.requestCancellation !== "function"
    ) {
      throw new TypeError("RunConfig.cancellation must be a RunCancellationController.");
    }
    if (config.cancellation.context.runId !== runId) {
      throw new TypeError("RunConfig cancellation runId must match RunInput.runId.");
    }
    assertMetadata(config.metadata, "RunConfig.metadata");

    return {
      valid: true,
      config: Object.freeze({
        workspace,
        identity: Object.freeze({
          ...config.identity,
          metadata: Object.freeze({ ...config.identity.metadata }),
        }),
        limits: Object.freeze({
          ...config.limits,
          plan: Object.freeze({ ...config.limits.plan }),
        }),
        audit: config.audit,
        telemetry: config.telemetry,
        cancellation: config.cancellation,
        metadata: Object.freeze({ ...config.metadata }),
      }),
    };
  } catch (error) {
    return {
      valid: false,
      error: Object.freeze({
        owner: "runtime",
        code: "runtime_invalid_options",
        message: error instanceof Error ? error.message : "RunConfig is invalid.",
        retryable: false,
        metadata: Object.freeze({}),
      }),
    };
  }
}

export function validateControllerDecision(
  candidate: ControllerDecision<unknown>,
): string | null {
  if (!isRecord(candidate)) {
    return "Controller decision must be an object.";
  }
  if (!Array.isArray(candidate.modelItems) || candidate.modelItems.length === 0) {
    return "Controller decision must include model items.";
  }
  const modelItemIds = new Set<string>();
  for (const item of candidate.modelItems) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.trim().length === 0) {
      return "Controller model items require non-empty ids.";
    }
    if (modelItemIds.has(item.id)) {
      return `Controller model item id ${item.id} is duplicated.`;
    }
    modelItemIds.add(item.id);
    if (typeof item.kind !== "string" || item.kind.trim().length === 0 || !isRecord(item.metadata)) {
      return `Controller model item ${item.id} is malformed.`;
    }
  }

  if (candidate.kind === "final_output") {
    return null;
  }
  if (candidate.kind === "stop") {
    return typeof candidate.reason === "string" && candidate.reason.trim().length > 0
      ? null
      : "Controller stop decision requires a reason.";
  }
  if (candidate.kind !== "actions" || !Array.isArray(candidate.actions) || candidate.actions.length === 0) {
    return "Controller decision kind is unsupported or contains no actions.";
  }
  for (const action of candidate.actions) {
    if (
      !isRecord(action) ||
      (action.kind !== "internal" && action.kind !== "tool" && action.kind !== "permission_request") ||
      typeof action.name !== "string" ||
      action.name.trim().length === 0 ||
      typeof action.modelItemId !== "string" ||
      !modelItemIds.has(action.modelItemId)
    ) {
      return "Controller action is malformed or has invalid provenance.";
    }
  }
  return null;
}

function snapshotWorkspaceScope(
  scope: NonNullable<RunInput["task"]["workspaceScope"]>,
): NonNullable<RunInput["task"]["workspaceScope"]> {
  if (!isRecord(scope) || !isRecord(scope.roots)) {
    throw new TypeError("RunInput.task.workspaceScope.roots must be an object.");
  }

  const roots: Record<string, WorkspaceContext> = {};
  for (const [name, workspace] of Object.entries(scope.roots)) {
    assertNonEmpty(name, "RunInput.task.workspaceScope root name");
    roots[name] = snapshotWorkspaceContext(
      workspace,
      `RunInput.task.workspaceScope.roots.${name}`,
    );
  }
  if (scope.defaultRootName !== undefined) {
    assertNonEmpty(scope.defaultRootName, "RunInput.task.workspaceScope.defaultRootName");
  }

  return Object.freeze({
    roots: Object.freeze(roots),
    ...(scope.defaultRootName === undefined
      ? {}
      : { defaultRootName: scope.defaultRootName }),
  });
}

function snapshotWorkspaceContext(
  workspace: WorkspaceContext,
  field: string,
): WorkspaceContext {
  if (!isRecord(workspace)) {
    throw new TypeError(`${field} must be a WorkspaceContext.`);
  }
  assertNonEmpty(workspace.id, `${field}.id`);
  assertNonEmpty(workspace.name, `${field}.name`);
  assertNonEmpty(workspace.source, `${field}.source`);
  if (workspace.rootRef !== null && typeof workspace.rootRef !== "string") {
    throw new TypeError(`${field}.rootRef must be text or null.`);
  }
  if (
    workspace.trustState !== "trusted" &&
    workspace.trustState !== "restricted" &&
    workspace.trustState !== "unknown"
  ) {
    throw new TypeError(`${field}.trustState is unsupported.`);
  }
  if (!Array.isArray(workspace.policyRefs) ||
      workspace.policyRefs.some((policyRef) => typeof policyRef !== "string")) {
    throw new TypeError(`${field}.policyRefs must be a string array.`);
  }
  assertMetadata(workspace.metadata, `${field}.metadata`);

  return Object.freeze({
    ...workspace,
    policyRefs: Object.freeze([...workspace.policyRefs]) as unknown as string[],
    metadata: Object.freeze({ ...workspace.metadata }),
  });
}

function snapshotConversationItem(
  item: RunInputItem,
  index: number,
  ids: Set<string>,
): RunInputItem {
  if (!isRecord(item)) {
    throw new TypeError(`RunInput conversation item ${index} must be an object.`);
  }
  assertNonEmpty(item.id, `RunInput conversation item ${index} id`);
  if (ids.has(item.id)) {
    throw new TypeError(`RunInput conversation item id ${item.id} is duplicated.`);
  }
  ids.add(item.id);
  if (item.kind !== "message") {
    throw new TypeError(`RunInput conversation item ${item.id} kind is unsupported.`);
  }
  if (item.role !== "system" && item.role !== "user" && item.role !== "assistant") {
    throw new TypeError(`RunInput conversation item ${item.id} role is unsupported.`);
  }
  if (typeof item.content !== "string") {
    throw new TypeError(`RunInput conversation item ${item.id} content must be text.`);
  }
  assertDateTime(item.createdAt, `RunInput conversation item ${item.id} createdAt`);
  assertMetadata(item.metadata, `RunInput conversation item ${item.id} metadata`);
  return Object.freeze({ ...item, metadata: Object.freeze({ ...item.metadata }) });
}

function assertRequirement(value: unknown, field: string): void {
  if (value !== "optional" && value !== "required") {
    throw new TypeError(`${field} must be optional or required.`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer.`);
  }
}

function assertDateTime(value: unknown, field: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid date-time string.`);
  }
}

function assertMetadata(value: unknown, field: string): asserts value is Metadata {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object.`);
  }
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
