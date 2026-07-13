import type { Evidence } from "@agent-anything/evidence";
import type { PermissionMode } from "@agent-anything/permission";
import type { ArtifactRef, EvidenceRef, Metadata } from "@agent-anything/shared";
import type { StoragePort } from "@agent-anything/storage";
import type { ToolCall, ToolResult } from "@agent-anything/tools";
import type {
  ToolActionBridge,
  ToolActionBridgeInput,
  ToolActionBridgeResult,
  ToolActionObservationPayload,
} from "../runner/ToolActionBridge.js";
import type { RunFailureCode } from "../runner/RunResult.js";
import type {
  RuntimeError,
} from "../runner/RuntimeError.js";
import {
  ToolExecutionBoundary,
  type ToolExecutionConfig,
  type ToolExecutionOutcome,
} from "./ToolExecutionBoundary.js";

export interface TemporaryToolActionBridgeDependencies {
  readonly boundary: ToolExecutionBoundary;
  readonly storage: StoragePort;
  readonly permissionMode: PermissionMode;
}

/** Transitional Tool bridge retained until Phase16 ActionExecutionBoundary replaces it. */
export class TemporaryToolActionBridge implements ToolActionBridge {
  constructor(
    private readonly dependencies: TemporaryToolActionBridgeDependencies,
  ) {}

  async execute(input: ToolActionBridgeInput): Promise<ToolActionBridgeResult> {
    throwIfCancelled(input);

    const toolCall: ToolCall = Object.freeze({
      id: input.action.id,
      toolName: input.action.name,
      input: input.action.input,
      risk: input.toolRisk,
      metadata: Object.freeze({
        runId: input.action.runId,
        actionId: input.action.id,
        controllerIteration: input.action.provenance.controllerIteration,
      }),
    });
    const outcome = await this.dependencies.boundary.execute({
      task: input.task,
      toolCall,
      config: createToolExecutionConfig(input, this.dependencies),
      workspace: input.workspace,
      identity: input.identity,
    });

    return this.mapOutcome(input, outcome);
  }

  private async mapOutcome(
    input: ToolActionBridgeInput,
    outcome: ToolExecutionOutcome,
  ): Promise<ToolActionBridgeResult> {
    if (outcome.status === "succeeded") {
      return this.mapSucceeded(input, outcome.toolResult, outcome.evidence);
    }

    if (outcome.errors.length === 0) {
      return terminalFailure(
        "tool_execution_failed",
        [runnerError(
          "tool",
          "tool_execution_outcome_invalid",
          "ToolExecutionBoundary returned a failure without errors.",
          { actionId: input.action.id, boundaryStatus: outcome.status },
        )],
      );
    }

    const terminalCode = terminalCodeFor(outcome.errors);
    if (terminalCode !== null) {
      return terminalFailure(
        terminalCode,
        outcome.errors,
      );
    }

    const error = outcome.errors[0];
    if (error === undefined) {
      throw new Error("Tool execution failure lost its required error.");
    }

    if (outcome.status === "blocked") {
      return observed("denied", {
        kind: "action_denied",
        owner: deniedOwner(error.code),
        code: error.code,
        message: error.message,
        metadata: freezeMetadata(error.metadata),
      });
    }

    if (error.code === "tool_not_found") {
      return observed("failed", {
        kind: "action_rejected",
        code: "tool_not_found",
        message: error.message,
        metadata: freezeMetadata(error.metadata),
      });
    }
    if (error.code === "tool_risk_mismatch") {
      return observed("failed", {
        kind: "action_rejected",
        code: "action_invalid",
        message: error.message,
        metadata: freezeMetadata(error.metadata),
      });
    }

    return observed("failed", {
      kind: "action_failure",
      error,
      metadata: freezeMetadata(error.metadata),
    });
  }

  private async mapSucceeded(
    input: ToolActionBridgeInput,
    toolResult: ToolResult,
    evidence: readonly Evidence[],
  ): Promise<ToolActionBridgeResult> {
    const evidenceRefs = Object.freeze(evidence.map((item) => item.id));
    const artifactRefs: ArtifactRef[] = [];

    if (input.cancellation.request === null) {
      for (const item of evidence) {
        if (input.cancellation.request !== null) {
          break;
        }
        try {
          const artifact = await this.dependencies.storage.storeEvidence(item);
          artifactRefs.push(artifact.id);
        } catch (error) {
          return terminalFailure(
            "storage_write_failed",
            [runnerError(
              "storage",
              "storage_write_failed",
              error instanceof Error ? error.message : "Failed to store tool evidence.",
              { actionId: input.action.id, evidenceId: item.id },
            )],
            evidenceRefs,
            artifactRefs,
          );
        }
      }
    }

    const observation = toolResult.status === "skipped"
      ? null
      : Object.freeze({
          kind: "tool_result" as const,
          result: freezeToolResult(toolResult),
          metadata: Object.freeze({
            toolName: toolResult.toolName,
            toolResultStatus: toolResult.status,
          }),
        });

    return Object.freeze({
      status: "observed" as const,
      outcome: "succeeded" as const,
      observation,
      evidenceRefs,
      artifactRefs: Object.freeze(artifactRefs),
    });
  }
}

function createToolExecutionConfig(
  input: ToolActionBridgeInput,
  dependencies: TemporaryToolActionBridgeDependencies,
): ToolExecutionConfig {
  return Object.freeze({
    permissionMode: dependencies.permissionMode,
    audit: input.audit,
    telemetry: input.telemetry,
  });
}

function observed(
  outcome: "denied" | "failed",
  observation: ToolActionObservationPayload,
): ToolActionBridgeResult {
  const references = {
    evidenceRefs: Object.freeze([]) as readonly EvidenceRef[],
    artifactRefs: Object.freeze([]) as readonly ArtifactRef[],
  };
  if (outcome === "denied" && observation.kind === "action_denied") {
    return Object.freeze({
      status: "observed" as const,
      outcome,
      observation: Object.freeze(observation),
      ...references,
    });
  }
  if (
    outcome === "failed" &&
    (observation.kind === "action_failure" || observation.kind === "action_rejected")
  ) {
    return Object.freeze({
      status: "observed" as const,
      outcome,
      observation: Object.freeze(observation),
      ...references,
    });
  }
  throw new Error(`Tool action outcome ${outcome} does not match ${observation.kind}.`);
}

function terminalFailure(
  code: RunFailureCode,
  errors: readonly RuntimeError[],
  evidenceRefs: readonly EvidenceRef[] = [],
  artifactRefs: readonly ArtifactRef[] = [],
): ToolActionBridgeResult {
  const normalizedErrors = errors.length > 0
    ? errors
    : [runnerError(
        "tool",
        "tool_execution_outcome_invalid",
        "Tool action bridge requires at least one terminal error.",
      )];
  return Object.freeze({
    status: "terminal_failure" as const,
    code,
    errors: Object.freeze([...normalizedErrors]) as unknown as readonly [
      RuntimeError,
      ...RuntimeError[],
    ],
    evidenceRefs: Object.freeze([...evidenceRefs]),
    artifactRefs: Object.freeze([...artifactRefs]),
  });
}

function terminalCodeFor(errors: readonly RuntimeError[]): RunFailureCode | null {
  for (const error of errors) {
    if (error.code === "audit_required_failed") {
      return "audit_required_failed";
    }
    if (error.code === "runtime_telemetry_required_failed") {
      return "runtime_telemetry_required_failed";
    }
    if (error.code === "runtime_evidence_creation_failed") {
      return "tool_execution_failed";
    }
  }
  return null;
}

function deniedOwner(code: string): "policy" | "permission" | "tool" {
  if (code.startsWith("policy_")) {
    return "policy";
  }
  if (code.startsWith("permission_")) {
    return "permission";
  }
  return "tool";
}

function runnerError(
  owner: RuntimeError["owner"],
  code: string,
  message: string,
  metadata: Metadata = {},
): RuntimeError {
  return Object.freeze({
    owner,
    code,
    message,
    retryable: false,
    metadata: freezeMetadata(metadata),
  });
}

function freezeToolResult(toolResult: ToolResult): ToolResult {
  return Object.freeze({
    ...toolResult,
    error: toolResult.error === null
      ? null
      : Object.freeze({
          ...toolResult.error,
          ...(toolResult.error.metadata === undefined
            ? {}
            : { metadata: freezeMetadata(toolResult.error.metadata) }),
        }),
    metadata: freezeMetadata(toolResult.metadata),
  });
}

function freezeMetadata(metadata: Metadata | undefined): Metadata {
  return Object.freeze({ ...(metadata ?? {}) });
}

function throwIfCancelled(input: ToolActionBridgeInput): void {
  if (!input.cancellation.signal.aborted && input.cancellation.request === null) {
    return;
  }
  throw input.cancellation.signal.reason ?? new Error("Tool action was cancelled before dispatch.");
}
