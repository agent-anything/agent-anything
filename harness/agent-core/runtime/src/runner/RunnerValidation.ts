import { snapshotAgent } from "@agent-anything/agent-core/agent";
import { snapshotRunInput } from "@agent-anything/agent-core/input";
import { snapshotIdentityRef } from "@agent-anything/agent-core/run";
import { snapshotToolSelectionRevision } from "@agent-anything/tools/selection";
import { snapshotWorkspaceSelection } from "@agent-anything/workspace/selection";
import {
  createCanonicalActorIdentity,
  createCanonicalEnvironmentIdentity,
  createCanonicalWorkspaceIdentity,
} from "@agent-anything/canonical-action/subject";
import { assertValidPlanLimits } from "../plan/index.js";
import { snapshotRetryPolicy } from "../retry/index.js";
import {
  snapshotResolvedRunPermissionConfig,
  type RuntimeFailure,
} from "../run/index.js";
import type { RunConfig, ValidatedRunConfig } from "./RunConfig.js";

export { snapshotAgent, snapshotRunInput };

export interface ConfigValidationFailure {
  readonly valid: false;
  readonly failure: RuntimeFailure & { readonly code: "runtime_invalid_options" };
}

export interface ConfigValidationSuccess {
  readonly valid: true;
  readonly config: ValidatedRunConfig;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function snapshotRunConfig(
  config: RunConfig,
): ConfigValidationSuccess | ConfigValidationFailure {
  try {
    if (!isRecord(config)) throw new TypeError("RunConfig must be an object.");
    const workspace = config.workspace === null
      ? null
      : snapshotWorkspaceSelection(config.workspace);
    const identity = snapshotIdentityRef(config.identity);
    const permissions = snapshotResolvedRunPermissionConfig({
      permissions: config.permissions,
      workspace,
      identity,
    });
    if (workspace === null && permissions.permissionProfile.workspaceRoots.length > 0) {
      throw new TypeError(
        "A Run without Workspace context cannot carry Permission workspace roots.",
      );
    }
    const tools = snapshotToolSelectionRevision(config.tools);
    const actionExecution = snapshotActionExecution(config.actionExecution);
    if (
      actionExecution !== null &&
      actionExecution.securityContext.environment.environmentId !==
        permissions.permissionProfile.environmentId
    ) {
      throw new TypeError(
        "Run Action execution and Permission profile must use the same environment.",
      );
    }
    if (
      actionExecution !== null &&
      actionExecution.securityContext.actor.identityId !== identity.id
    ) {
      throw new TypeError("Run Action actor and Run identity must match.");
    }
    if (
      actionExecution !== null &&
      actionExecution.securityContext.workspace?.workspaceId !==
        (workspace?.primary.id ?? undefined)
    ) {
      throw new TypeError("Run Action workspace and Run primary workspace must match.");
    }
    const limits = snapshotLimits(config.limits);
    const descendantDepth = config.descendantDepth ?? 0;
    assertNonNegativeInteger(descendantDepth, "RunConfig.descendantDepth");
    if (descendantDepth > limits.maxDescendantDepth) {
      throw new TypeError("Run descendant depth exceeds the configured ceiling.");
    }
    assertRequirement(config.audit, "RunConfig.audit");
    assertRequirement(config.telemetry, "RunConfig.telemetry");
    const cancellationLimits = snapshotCancellationLimits(config.cancellationLimits);
    if (!isRecord(config.retry)) {
      throw new TypeError("RunConfig.retry must be a ResolvedRunRetryConfiguration.");
    }
    const retry = Object.freeze({
      providerRequest: snapshotRetryPolicy(
        config.retry.providerRequest,
        "RunConfig.retry.providerRequest",
      ),
      structuredOutput: snapshotRetryPolicy(
        config.retry.structuredOutput,
        "RunConfig.retry.structuredOutput",
      ),
      action: Object.freeze({
        maxAttempts: positiveInteger(
          config.retry.action?.maxAttempts,
          "RunConfig.retry.action.maxAttempts",
        ),
      }),
    });
    assertMetadata(config.metadata, "RunConfig.metadata");

    return Object.freeze({
      valid: true as const,
      config: Object.freeze({
        workspace,
        identity,
        permissions,
        tools,
        actionExecution,
        limits,
        audit: config.audit,
        telemetry: config.telemetry,
        cancellationLimits,
        retry,
        metadata: Object.freeze({ ...config.metadata }),
        descendantDepth,
      }),
    });
  } catch (error) {
    return Object.freeze({
      valid: false as const,
      failure: Object.freeze({
        code: "runtime_invalid_options" as const,
        message: error instanceof Error ? error.message : "RunConfig is invalid.",
        retryable: false,
        metadata: Object.freeze({}),
      }),
    });
  }
}

function snapshotActionExecution(
  input: RunConfig["actionExecution"],
): RunConfig["actionExecution"] {
  if (input === null) return null;
  if (!isRecord(input)) throw new TypeError("RunConfig.actionExecution must be an object or null.");
  const enforcement = input.enforcement;
  if (enforcement !== "managed" && enforcement !== "external" && enforcement !== "disabled") {
    throw new TypeError("RunConfig.actionExecution.enforcement is unsupported.");
  }
  assertToken(input.policySnapshotId, "RunConfig.actionExecution.policySnapshotId");
  if (!isRecord(input.securityContext)) {
    throw new TypeError("RunConfig.actionExecution.securityContext must be an object.");
  }
  const workspace = input.securityContext.workspace === null
    ? null
    : createCanonicalWorkspaceIdentity({
        workspaceId: input.securityContext.workspace.workspaceId,
        trustState: input.securityContext.workspace.trustState,
        roots: input.securityContext.workspace.roots.map((root) => ({
          rootId: root.rootId,
          platform: root.platform,
          path: root.canonicalPath,
          resolvedPath: root.resolvedPath ?? root.canonicalPath,
          resolutionFingerprint: root.resolutionFingerprint,
        })),
      });
  const actor = createCanonicalActorIdentity(input.securityContext.actor);
  const environment = createCanonicalEnvironmentIdentity(
    input.securityContext.environment,
  );
  assertMetadata(input.metadata, "RunConfig.actionExecution.metadata");
  return Object.freeze({
    policySnapshotId: input.policySnapshotId,
    securityContext: Object.freeze({ workspace, actor, environment }),
    enforcement,
    metadata: Object.freeze({ ...input.metadata }),
  });
}

function snapshotLimits(input: RunConfig["limits"]): RunConfig["limits"] {
  if (!isRecord(input)) throw new TypeError("RunConfig.limits must be an object.");
  const limits = Object.freeze({
    maxIterations: positiveInteger(input.maxIterations, "RunLimits.maxIterations"),
    maxActions: nonNegativeInteger(input.maxActions, "RunLimits.maxActions"),
    maxConsecutiveActionFailures: nonNegativeInteger(
      input.maxConsecutiveActionFailures,
      "RunLimits.maxConsecutiveActionFailures",
    ),
    maxDurationMs: positiveTimer(input.maxDurationMs, "RunLimits.maxDurationMs"),
    maxPendingInteractions: nonNegativeInteger(
      input.maxPendingInteractions,
      "RunLimits.maxPendingInteractions",
    ),
    maxDescendantRuns: nonNegativeInteger(
      input.maxDescendantRuns,
      "RunLimits.maxDescendantRuns",
    ),
    maxDescendantDepth: nonNegativeInteger(
      input.maxDescendantDepth,
      "RunLimits.maxDescendantDepth",
    ),
    plan: Object.freeze({ ...input.plan }),
  });
  assertValidPlanLimits(limits.plan);
  return limits;
}

function snapshotCancellationLimits(
  input: RunConfig["cancellationLimits"],
): RunConfig["cancellationLimits"] {
  if (!isRecord(input)) throw new TypeError("RunConfig.cancellationLimits must be an object.");
  return Object.freeze({
    operationSettlementTimeoutMs: positiveTimer(input.operationSettlementTimeoutMs, "CancellationLimits.operationSettlementTimeoutMs"),
    processGracePeriodMs: positiveTimer(input.processGracePeriodMs, "CancellationLimits.processGracePeriodMs"),
    processForceKillTimeoutMs: positiveTimer(input.processForceKillTimeoutMs, "CancellationLimits.processForceKillTimeoutMs"),
    finalizationTimeoutMs: positiveTimer(input.finalizationTimeoutMs, "CancellationLimits.finalizationTimeoutMs"),
  });
}

function assertRequirement(value: unknown, field: string): asserts value is "optional" | "required" {
  if (value !== "optional" && value !== "required") {
    throw new TypeError(`${field} must be optional or required.`);
  }
}

function positiveTimer(value: unknown, field: string): number {
  const result = positiveInteger(value, field);
  if (result > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`${field} must not exceed ${MAX_TIMER_DELAY_MS}.`);
  }
  return result;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return value as number;
}

function assertNonNegativeInteger(value: unknown, field: string): void {
  nonNegativeInteger(value, field);
}

function assertToken(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a canonical token.`);
  }
}

function assertMetadata(value: unknown, field: string): asserts value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object.`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
