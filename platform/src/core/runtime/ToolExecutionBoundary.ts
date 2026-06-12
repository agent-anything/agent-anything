import type { Observation } from "../context/index.js";
import type { AgentTask } from "../task/index.js";
import { createAuditRecord, type AuditPort } from "../../audit/index.js";
import type { Evidence, EvidenceBuilderPort } from "../../evidence/index.js";
import {
  createAllowAllPolicyPort,
  type PolicyDecision,
  type PolicyPort,
  type PolicySubject,
  type PolicyWorkspace,
} from "../../governance/index.js";
import type { IdentityRef } from "../../identity/index.js";
import {
  createPermissionRequest,
  createPermissionServiceFromMode,
  type PermissionDecision,
  type PermissionService,
} from "../../permission/index.js";
import { createTelemetryRecord, type TelemetryPort } from "../../telemetry/index.js";
import type { ToolCall, ToolRegistry, ToolResult } from "../../tools/index.js";
import type { WorkspaceContext } from "../../workspace/index.js";
import type { RuntimeError } from "./RuntimeError.js";
import type { RuntimeOptions } from "./RuntimeOptions.js";

export interface ToolExecutionBoundaryDependencies {
  toolRegistry: ToolRegistry;
  evidenceBuilder: EvidenceBuilderPort;
  policyPort?: PolicyPort;
  permissionService?: PermissionService;
  auditPort?: AuditPort;
  telemetryPort?: TelemetryPort;
}

export interface ExecuteToolInput {
  task: AgentTask;
  toolCall: ToolCall;
  options: RuntimeOptions;
  workspace?: WorkspaceContext;
  identity?: IdentityRef;
}

export type ToolExecutionOutcome =
  | ToolExecutionSucceeded
  | ToolExecutionFailed
  | ToolExecutionBlocked;

export interface ToolExecutionSucceeded {
  status: "succeeded";
  toolResult: ToolResult;
  evidence: Evidence[];
  observation: Observation | null;
}

export interface ToolExecutionFailed {
  status: "failed";
  toolResult: ToolResult | null;
  errors: RuntimeError[];
}

export interface ToolExecutionBlocked {
  status: "blocked";
  toolResult: ToolResult | null;
  errors: RuntimeError[];
}

export class ToolExecutionBoundary {
  constructor(
    private readonly dependencies: ToolExecutionBoundaryDependencies,
  ) {}

  async execute(input: ExecuteToolInput): Promise<ToolExecutionOutcome> {
    const policyOutcome = await this.checkPolicy(input);
    if (policyOutcome) {
      return policyOutcome;
    }

    const permissionOutcome = await this.checkPermission(input);
    if (permissionOutcome) {
      return permissionOutcome;
    }

    const toolResult = await this.dependencies.toolRegistry.execute(input.toolCall);
    const statusError = validateToolResultStatus(toolResult);
    if (statusError) {
      return {
        status: "failed",
        toolResult,
        errors: [statusError],
      };
    }

    if (!shouldCreateEvidence(toolResult)) {
      return {
        status: "succeeded",
        toolResult,
        evidence: [],
        observation: null,
      };
    }

    let evidence: Evidence[];
    try {
      evidence = this.dependencies.evidenceBuilder.buildFromToolResult({
        toolResult,
      });
    } catch (error) {
      return {
        status: "failed",
        toolResult,
        errors: [
          {
            code: "runtime_evidence_creation_failed",
            message: error instanceof Error
              ? error.message
              : "Failed to build evidence from tool result.",
            metadata: {
              toolCallId: toolResult.toolCallId,
              toolName: toolResult.toolName,
            },
          },
        ],
      };
    }

    return {
      status: "succeeded",
      toolResult,
      evidence,
      observation: createObservation(toolResult, evidence),
    };
  }

  private async checkPolicy(input: ExecuteToolInput): Promise<ToolExecutionFailed | ToolExecutionBlocked | null> {
    if (!isGovernedToolCall(input.toolCall)) {
      return null;
    }

    const checkId = `policy_check_${input.toolCall.id}`;
    try {
      const policyPort = this.dependencies.policyPort ?? createAllowAllPolicyPort();
      const decision = await policyPort.evaluate({
        id: checkId,
        taskId: input.task.id,
        action: "tool.execute",
        subject: mapIdentityToPolicySubject(input.identity),
        risk: input.toolCall.risk,
        workspace: mapWorkspaceToPolicyWorkspace(input.workspace),
        target: {
          kind: "tool",
          name: input.toolCall.toolName,
          resource: input.toolCall.id,
        },
        metadata: {
          source: "tool-execution-boundary",
        },
      });
      const recordError = await this.recordPolicyDecision(input, decision);
      if (recordError) {
        return recordError;
      }

      if (decision.status === "allowed") {
        return null;
      }

      return {
        status: "blocked",
        toolResult: null,
        errors: [
          {
            code: decision.code ?? (decision.status === "requires_review"
              ? "policy_review_required"
              : "policy_denied"),
            message: decision.reason ?? (decision.status === "requires_review"
              ? "Policy review is required before tool execution."
              : "Policy denied tool execution."),
            metadata: {
              checkId: decision.checkId,
              toolCallId: input.toolCall.id,
              toolName: input.toolCall.toolName,
              policyDecisionStatus: decision.status,
              ...decision.metadata,
            },
          },
        ],
      };
    } catch (error) {
      return {
        status: "failed",
        toolResult: null,
        errors: [
          {
            code: "policy_check_failed",
            message: error instanceof Error
              ? error.message
              : "Policy check failed.",
            metadata: {
              checkId,
              toolCallId: input.toolCall.id,
              toolName: input.toolCall.toolName,
            },
          },
        ],
      };
    }
  }

  private async checkPermission(input: ExecuteToolInput): Promise<ToolExecutionFailed | ToolExecutionBlocked | null> {
    if (!isGovernedToolCall(input.toolCall)) {
      return null;
    }

    const permissionRequest = createPermissionRequest({
      id: `permission_request_${input.toolCall.id}`,
      taskId: input.task.id,
      toolCall: input.toolCall,
      reason: `Tool ${input.toolCall.toolName} is marked as risky.`,
      metadata: {
        source: "tool-execution-boundary",
      },
    });
    let decision;
    try {
      const permissionService = this.dependencies.permissionService
        ?? createPermissionServiceFromMode(input.options.permissionMode);
      decision = await permissionService.request(permissionRequest);
    } catch (error) {
      return {
        status: "failed",
        toolResult: null,
        errors: [
          {
            code: "permission_check_failed",
            message: error instanceof Error
              ? error.message
              : "Permission service failed.",
            metadata: {
              requestId: permissionRequest.id,
              toolCallId: input.toolCall.id,
              toolName: input.toolCall.toolName,
            },
          },
        ],
      };
    }

    const recordError = await this.recordPermissionDecision(input, decision);
    if (recordError) {
      return recordError;
    }

    if (decision.status === "granted") {
      return null;
    }

    return {
      status: "blocked",
      toolResult: null,
      errors: [
        {
          code: decision.code ?? "permission_denied",
          message: decision.reason,
          metadata: {
            requestId: decision.requestId,
            toolCallId: input.toolCall.id,
            toolName: input.toolCall.toolName,
          },
        },
      ],
    };
  }

  private async recordPolicyDecision(
    input: ExecuteToolInput,
    decision: PolicyDecision,
  ): Promise<ToolExecutionFailed | null> {
    const auditError = await this.recordAudit(input, {
      id: `audit_policy_checked_${input.toolCall.id}`,
      eventName: "policy.checked",
      action: "policy.check",
      outcome: decision.status === "allowed" ? "succeeded" : "blocked",
      payload: {
        checkId: decision.checkId,
        decisionStatus: decision.status,
        code: decision.code ?? null,
        toolCallId: input.toolCall.id,
        toolName: input.toolCall.toolName,
      },
    });
    if (auditError) {
      return auditError;
    }

    return this.recordTelemetry(input, {
      id: `telemetry_policy_checked_${input.toolCall.id}`,
      eventName: "runtime.policy.checked",
      dimensions: {
        decisionStatus: decision.status,
        code: decision.code ?? null,
        toolName: input.toolCall.toolName,
      },
      counters: {
        policyChecks: 1,
      },
    });
  }

  private async recordPermissionDecision(
    input: ExecuteToolInput,
    decision: PermissionDecision,
  ): Promise<ToolExecutionFailed | null> {
    const auditError = await this.recordAudit(input, {
      id: `audit_permission_resolved_${input.toolCall.id}`,
      eventName: "permission.resolved",
      action: "permission.resolve",
      outcome: decision.status === "granted" ? "succeeded" : "blocked",
      payload: {
        requestId: decision.requestId,
        decisionStatus: decision.status,
        code: decision.code ?? null,
        permissionMode: input.options.permissionMode,
        toolCallId: input.toolCall.id,
        toolName: input.toolCall.toolName,
      },
    });
    if (auditError) {
      return auditError;
    }

    return this.recordTelemetry(input, {
      id: `telemetry_permission_resolved_${input.toolCall.id}`,
      eventName: "runtime.permission.resolved",
      dimensions: {
        decisionStatus: decision.status,
        code: decision.code ?? null,
        permissionMode: input.options.permissionMode,
        toolName: input.toolCall.toolName,
      },
      counters: {
        permissionDecisions: 1,
      },
    });
  }

  private async recordAudit(
    input: ExecuteToolInput,
    event: {
      id: string;
      eventName: string;
      action: string;
      outcome: "succeeded" | "failed" | "blocked" | "cancelled";
      payload: Record<string, unknown>;
    },
  ): Promise<ToolExecutionFailed | null> {
    if (!this.dependencies.auditPort) {
      return null;
    }

    try {
      await this.dependencies.auditPort.record(createAuditRecord({
        id: event.id,
        taskId: input.task.id,
        eventName: event.eventName,
        timestamp: new Date().toISOString(),
        actorRef: input.identity?.id ?? null,
        workspaceId: input.workspace?.id ?? null,
        subject: {
          kind: input.identity?.kind ?? "agent",
          id: input.identity?.id ?? "agent",
          metadata: input.identity?.metadata ?? {},
        },
        action: event.action,
        target: {
          kind: "tool",
          id: input.toolCall.id,
          metadata: {
            toolName: input.toolCall.toolName,
          },
        },
        outcome: event.outcome,
        payload: event.payload,
        metadata: {
          source: "tool-execution-boundary",
        },
      }));
      return null;
    } catch (error) {
      if ((input.options.auditMode ?? "optional") !== "required") {
        return null;
      }

      return {
        status: "failed",
        toolResult: null,
        errors: [
          {
            code: "audit_required_failed",
            message: error instanceof Error ? error.message : "Required audit recording failed.",
            metadata: {
              eventName: event.eventName,
              toolCallId: input.toolCall.id,
              toolName: input.toolCall.toolName,
            },
          },
        ],
      };
    }
  }

  private async recordTelemetry(
    input: ExecuteToolInput,
    event: {
      id: string;
      eventName: string;
      counters: Record<string, number>;
      dimensions: Record<string, string | number | boolean | null>;
    },
  ): Promise<ToolExecutionFailed | null> {
    if (!this.dependencies.telemetryPort) {
      return null;
    }

    try {
      await this.dependencies.telemetryPort.record(createTelemetryRecord({
        id: event.id,
        taskId: input.task.id,
        eventName: event.eventName,
        timestamp: new Date().toISOString(),
        counters: event.counters,
        dimensions: event.dimensions,
      }));
      return null;
    } catch (error) {
      if ((input.options.telemetryMode ?? "optional") !== "required") {
        return null;
      }

      return {
        status: "failed",
        toolResult: null,
        errors: [
          {
            code: "runtime_telemetry_required_failed",
            message: error instanceof Error ? error.message : "Required telemetry recording failed.",
            metadata: {
              eventName: event.eventName,
              toolCallId: input.toolCall.id,
              toolName: input.toolCall.toolName,
            },
          },
        ],
      };
    }
  }
}

function mapIdentityToPolicySubject(identity: IdentityRef | undefined): PolicySubject | undefined {
  if (!identity) {
    return undefined;
  }

  return {
    kind: identity.kind,
    id: identity.id,
    displayName: identity.displayName,
    metadata: identity.metadata,
  };
}

function mapWorkspaceToPolicyWorkspace(workspace: WorkspaceContext | undefined): PolicyWorkspace | undefined {
  if (!workspace) {
    return undefined;
  }

  return {
    id: workspace.id,
    trustLevel: typeof workspace.metadata.trustLevel === "string" &&
      (
        workspace.metadata.trustLevel === "trusted" ||
        workspace.metadata.trustLevel === "restricted" ||
        workspace.metadata.trustLevel === "unknown"
      )
      ? workspace.metadata.trustLevel
      : undefined,
    metadata: {
      name: workspace.name,
      rootRef: workspace.rootRef,
      policyRefs: workspace.policyRefs,
      ...workspace.metadata,
    },
  };
}

function isGovernedToolCall(toolCall: ToolCall): boolean {
  return toolCall.risk === "risky";
}

function validateToolResultStatus(toolResult: ToolResult): RuntimeError | null {
  switch (toolResult.status) {
    case "succeeded":
      return toolResult.output === null
        ? createToolStatusError(toolResult, {
          code: "tool_execution_failed",
          message: "Succeeded tool result must include usable output.",
        })
        : null;
    case "partial":
      return toolResult.output === null
        ? createToolStatusError(toolResult, {
          code: "tool_execution_failed",
          message: "Partial tool result must include usable output.",
        })
        : null;
    case "interrupted":
      return toolResult.output === null
        ? createToolStatusError(toolResult, {
          code: "tool_interrupted",
          message: toolResult.error?.message ?? "Tool execution was interrupted.",
        })
        : null;
    case "failed":
      return createToolStatusError(toolResult, {
        code: toolResult.error?.code === "tool_not_found"
          ? "tool_not_found"
          : "tool_execution_failed",
        message: toolResult.error?.message ?? "Tool execution failed.",
      });
    case "cancelled":
      return createToolStatusError(toolResult, {
        code: "tool_cancelled",
        message: toolResult.error?.message ?? "Tool execution was cancelled.",
      });
    case "timeout":
      return createToolStatusError(toolResult, {
        code: "tool_timeout",
        message: toolResult.error?.message ?? "Tool execution timed out.",
      });
    case "skipped":
      return null;
  }
}

function createToolStatusError(
  toolResult: ToolResult,
  input: Pick<RuntimeError, "code" | "message">,
): RuntimeError {
  return {
    code: input.code,
    message: input.message,
    metadata: {
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      toolResultStatus: toolResult.status,
      ...toolResult.error?.metadata,
    },
  };
}

function shouldCreateEvidence(toolResult: ToolResult): boolean {
  return (
    toolResult.output !== null &&
    (
      toolResult.status === "succeeded" ||
      toolResult.status === "partial" ||
      toolResult.status === "interrupted"
    )
  );
}

function createObservation(
  toolResult: ToolResult,
  evidence: Evidence[],
): Observation | null {
  if (evidence.length === 0) {
    return null;
  }

  return {
    id: `observation_${toolResult.toolCallId}`,
    source: {
      kind: "toolResult",
      id: toolResult.toolCallId,
      metadata: {
        toolName: toolResult.toolName,
        status: toolResult.status,
      },
    },
    summary: evidence[0]?.summary ?? `Tool ${toolResult.toolName} produced evidence.`,
    toolResultRef: toolResult.toolCallId,
    evidenceRefs: evidence.map((item) => item.id),
    metadata: {
      toolName: toolResult.toolName,
      toolResultStatus: toolResult.status,
    },
  };
}
