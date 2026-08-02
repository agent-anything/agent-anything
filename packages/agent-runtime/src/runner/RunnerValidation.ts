import {
  snapshotAgent,
  snapshotIdentityRef,
  snapshotRunInput,
  snapshotRunWorkspace,
  type Metadata,
  type RuntimeError,
} from "@agent-anything/foundation";
import type { ControllerDecision } from "@agent-anything/agent-core/controller";
import { assertValidPlanLimits } from "@agent-anything/agent-core/plan";
import { snapshotRetryPolicy } from "@agent-anything/agent-core/retry";
import { snapshotResolvedRunPermissionConfig } from "@agent-anything/agent-core/run";
import { snapshotRunActionContext } from "@agent-anything/action-execution";
import { createToolCatalogSnapshot } from "@agent-anything/tools";
import type { ResolvedRunConfig, RunConfig } from "./RunConfig.js";

export { snapshotAgent, snapshotRunInput };

export interface ConfigValidationFailure {
  readonly valid: false;
  readonly error: RuntimeError & { readonly code: "runtime_invalid_options" };
}

export interface ConfigValidationSuccess {
  readonly valid: true;
  readonly config: ResolvedRunConfig;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function snapshotRunConfig(
  config: RunConfig,
  runId: string,
): ConfigValidationSuccess | ConfigValidationFailure {
  try {
    if (!isRecord(config)) {
      throw new TypeError("RunConfig must be an object.");
    }
    const workspace = config.workspace === null
      ? null
      : snapshotRunWorkspace(config.workspace);
    const identity = snapshotIdentityRef(config.identity);
    const permissions = snapshotResolvedRunPermissionConfig({
      permissions: config.permissions,
      workspace,
      identity,
    });
    if (
      workspace === null &&
      permissions.permissionProfile.workspaceRoots.length > 0
    ) {
      throw new TypeError(
        "A Run without Workspace context cannot carry Permission workspace roots.",
      );
    }
    const actionContext = config.actionContext === null
      ? null
      : workspace === null
        ? (() => {
            throw new TypeError(
              "A Run without Workspace context cannot carry an Action context.",
            );
          })()
        : snapshotRunActionContext({
            context: config.actionContext,
            workspace,
            identity,
            profile: permissions.permissionProfile,
          });
    if (!isRecord(config.toolCatalog) || !Array.isArray(config.toolCatalog.tools)) {
      throw new TypeError("RunConfig.toolCatalog must be a ToolCatalogSnapshot.");
    }
    const toolCatalog = createToolCatalogSnapshot(config.toolCatalog.tools);

    if (!isRecord(config.limits)) {
      throw new TypeError("RunConfig.limits must be a RunLimits object.");
    }
    assertPositiveInteger(config.limits.maxIterations, "RunLimits.maxIterations");
    assertNonNegativeInteger(config.limits.maxActions, "RunLimits.maxActions");
    assertNonNegativeInteger(
      config.limits.maxConsecutiveActionFailures,
      "RunLimits.maxConsecutiveActionFailures",
    );
    assertPositiveTimerDelay(config.limits.maxDurationMs, "RunLimits.maxDurationMs");
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
    if (!isRecord(config.cancellationLimits)) {
      throw new TypeError("RunConfig.cancellationLimits must be a CancellationLimits object.");
    }
    assertPositiveTimerDelay(
      config.cancellationLimits.operationSettlementTimeoutMs,
      "CancellationLimits.operationSettlementTimeoutMs",
    );
    assertPositiveTimerDelay(
      config.cancellationLimits.processGracePeriodMs,
      "CancellationLimits.processGracePeriodMs",
    );
    assertPositiveTimerDelay(
      config.cancellationLimits.processForceKillTimeoutMs,
      "CancellationLimits.processForceKillTimeoutMs",
    );
    assertPositiveTimerDelay(
      config.cancellationLimits.finalizationTimeoutMs,
      "CancellationLimits.finalizationTimeoutMs",
    );
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
      approvalsReviewer: snapshotRetryPolicy(
        config.retry.approvalsReviewer,
        "RunConfig.retry.approvalsReviewer",
      ),
    });
    assertMetadata(config.metadata, "RunConfig.metadata");

    return {
      valid: true,
      config: Object.freeze({
        workspace,
        identity,
        actionContext,
        permissions,
        toolCatalog,
        limits: Object.freeze({
          ...config.limits,
          plan: Object.freeze({ ...config.limits.plan }),
        }),
        audit: config.audit,
        telemetry: config.telemetry,
        cancellation: config.cancellation,
        cancellationLimits: Object.freeze({ ...config.cancellationLimits }),
        retry,
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
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.id.trim().length === 0
    ) {
      return "Controller model items require non-empty ids.";
    }
    if (modelItemIds.has(item.id)) {
      return `Controller model item id ${item.id} is duplicated.`;
    }
    modelItemIds.add(item.id);
    if (
      typeof item.kind !== "string" ||
      item.kind.trim().length === 0 ||
      !isRecord(item.metadata)
    ) {
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
  if (
    candidate.kind !== "actions" ||
    !Array.isArray(candidate.actions) ||
    candidate.actions.length === 0
  ) {
    return "Controller decision kind is unsupported or contains no actions.";
  }
  for (const action of candidate.actions) {
    if (
      !isRecord(action) ||
      (
        action.kind !== "internal" &&
        action.kind !== "tool" &&
        action.kind !== "permission_request"
      ) ||
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

function assertPositiveTimerDelay(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(
      `${field} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}.`,
    );
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer.`);
  }
}

function assertMetadata(value: unknown, field: string): asserts value is Metadata {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
