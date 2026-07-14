import type { AgentTask } from "../task/index.js";
import { createAuditRecord, type AuditPort } from "@agent-anything/observability/audit";
import type { Evidence, EvidenceBuilderPort } from "@agent-anything/evidence";
import {
  createAllowAllPolicyPort,
  type PolicyDecision,
  type PolicyPort,
  type PolicySubject,
  type PolicyWorkspace,
} from "@agent-anything/governance";
import type { IdentityRef } from "@agent-anything/governance/identity";
import {
  createPermissionRequest,
  createPermissionServiceFromMode,
  type PermissionDecision,
  type PermissionMode,
  type PermissionService,
} from "@agent-anything/permission";
import { createTelemetryRecord, type TelemetryPort } from "@agent-anything/observability/telemetry";
import type {
  ToolCall,
  ToolInvocationContext,
  ToolRegistry,
  ToolResult,
} from "@agent-anything/tools";
import type { InvocationCancellationRef } from "@agent-anything/shared";
import type { WorkspaceContext } from "@agent-anything/governance/workspace";
import type { RunInfrastructureRequirement } from "../runner/RunConfig.js";
import type { RuntimeError } from "../runner/RuntimeError.js";
import { ToolExecutionContextError, type ToolExecutionContext, type ToolExecutionContextResolver } from "./ToolExecutionContextResolver.js";

export interface ToolExecutionBoundaryDependencies {
  toolRegistry: ToolRegistry;
  evidenceBuilder: EvidenceBuilderPort;
  policyPort?: PolicyPort;
  permissionService?: PermissionService;
  auditPort?: AuditPort;
  telemetryPort?: TelemetryPort;
  toolExecutionContextResolver?: ToolExecutionContextResolver;
}

export interface ExecuteToolInput {
  task: AgentTask;
  toolCall: ToolCall;
  config: ToolExecutionConfig;
  workspace?: WorkspaceContext;
  identity?: IdentityRef;
  executionContext?: ToolExecutionContext;
  invocation: ToolInvocationContext;
}

export interface ToolExecutionConfig {
  readonly permissionMode: PermissionMode;
  readonly audit: RunInfrastructureRequirement;
  readonly telemetry: RunInfrastructureRequirement;
}

export type ToolExecutionOutcome =
  | ToolExecutionSucceeded
  | ToolExecutionFailed
  | ToolExecutionBlocked
  | ToolExecutionCancelled;

export interface ToolExecutionSucceeded {
  status: "succeeded";
  toolResult: ToolResult;
  evidence: Evidence[];
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

export interface ToolExecutionCancelled {
  status: "cancelled";
  toolResult: ToolResult | null;
  cancellation: InvocationCancellationRef;
}

export class ToolExecutionBoundary {
  constructor(
    private readonly dependencies: ToolExecutionBoundaryDependencies,
  ) {}

  async execute(input: ExecuteToolInput): Promise<ToolExecutionOutcome> {
    const cancelledBeforePreparation = cancellationOutcome(input, null);
    if (cancelledBeforePreparation !== null) {
      return cancelledBeforePreparation;
    }

    const preparation = await this.prepareExecutionInput(input);
    if ("status" in preparation) {
      return preparation;
    }
    input = preparation.input;
    const cancelledAfterPreparation = cancellationOutcome(input, null);
    if (cancelledAfterPreparation !== null) {
      return cancelledAfterPreparation;
    }

    const policyOutcome = await this.checkPolicy(input);
    const cancelledAfterPolicy = cancellationOutcome(input, null);
    if (cancelledAfterPolicy !== null) {
      return cancelledAfterPolicy;
    }
    if (policyOutcome) {
      return policyOutcome;
    }

    const permissionOutcome = await this.checkPermission(input);
    const cancelledAfterPermission = cancellationOutcome(input, null);
    if (cancelledAfterPermission !== null) {
      return cancelledAfterPermission;
    }
    if (permissionOutcome) {
      return permissionOutcome;
    }

    const toolResult = await this.dependencies.toolRegistry.execute(
      input.toolCall,
      input.invocation,
    );
    const toolCancellation = classifyToolCancellation(input, toolResult);
    if (toolCancellation !== null) {
      return toolCancellation;
    }

    const statusError = validateToolResultStatus(toolResult);
    if (statusError) {
      return {
        status: "failed",
        toolResult,
        errors: [statusError],
      };
    }

    if (input.invocation.interruption.signal.aborted) {
      return {
        status: "succeeded",
        toolResult,
        evidence: [],
      };
    }

    if (!shouldCreateEvidence(toolResult)) {
      return {
        status: "succeeded",
        toolResult,
        evidence: [],
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
            owner: "tool",
            code: "runtime_evidence_creation_failed",
            message: error instanceof Error
              ? error.message
              : "Failed to build evidence from tool result.",
            metadata: {
              toolCallId: toolResult.toolCallId,
              toolName: toolResult.toolName,
            },
            retryable: false,
          },
        ],
      };
    }

    return {
      status: "succeeded",
      toolResult,
      evidence,
    };
  }

  private async prepareExecutionInput(
    input: ExecuteToolInput,
  ): Promise<
    { input: ExecuteToolInput } | ToolExecutionFailed | ToolExecutionCancelled
  > {
    const definition = this.dependencies.toolRegistry.get(input.toolCall.toolName);
    if (definition?.risk === "risky" && input.toolCall.risk !== "risky") {
      return {
        status: "failed",
        toolResult: null,
        errors: [
          {
            owner: "tool",
            code: "tool_risk_mismatch",
            message: "Tool call cannot downgrade the registered tool risk.",
            metadata: {
              toolCallId: input.toolCall.id,
              toolName: input.toolCall.toolName,
              callRisk: input.toolCall.risk,
              definitionRisk: definition.risk,
            },
            retryable: false,
          },
        ],
      };
    }

    let executionContext: ToolExecutionContext = {
      workspace: input.workspace,
      metadata: {},
    };

    if (this.dependencies.toolExecutionContextResolver) {
      try {
        executionContext =
          await this.dependencies.toolExecutionContextResolver.resolve({
            task: input.task,
            toolCall: input.toolCall,
            defaultWorkspace: input.workspace,
          });
        const cancellation = cancellationOutcome(input, null);
        if (cancellation !== null) {
          return cancellation;
        }
      } catch (error) {
        return {
          status: "failed",
          toolResult: null,
          errors: [
            {
              owner: "tool",
              code: error instanceof ToolExecutionContextError
                ? "tool_execution_context_invalid"
                : "tool_execution_context_resolution_failed",
              message: error instanceof ToolExecutionContextError
                ? error.message
                : "Failed to resolve trusted tool execution context.",
              metadata: {
                toolCallId: input.toolCall.id,
                toolName: input.toolCall.toolName,
                contextErrorCode: error instanceof ToolExecutionContextError
                  ? error.code
                  : null,
                ...(error instanceof ToolExecutionContextError
                  ? error.metadata
                  : {}),
              },
              retryable: false,
            },
          ],
        };
      }
    }

    return {
      input: {
        ...input,
        workspace: executionContext.workspace ?? input.workspace,
        executionContext,
      },
    };
  }
  private async checkPolicy(input: ExecuteToolInput): Promise<
    ToolExecutionFailed | ToolExecutionBlocked | ToolExecutionCancelled | null
  > {
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
          metadata: input.executionContext?.metadata,
        },
        metadata: {
          source: "tool-execution-boundary",
          taskKind: input.task.kind,
          ...input.executionContext?.metadata,
        },
      });
      const cancellation = cancellationOutcome(input, null);
      if (cancellation !== null) {
        return cancellation;
      }
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
            owner: "policy",
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
            retryable: false,
          },
        ],
      };
    } catch (error) {
      const cancellation = cancellationOutcome(input, null);
      if (cancellation !== null) {
        return cancellation;
      }
      return {
        status: "failed",
        toolResult: null,
        errors: [
          {
            owner: "policy",
            code: "policy_check_failed",
            message: error instanceof Error
              ? error.message
              : "Policy check failed.",
            metadata: {
              checkId,
              toolCallId: input.toolCall.id,
              toolName: input.toolCall.toolName,
            },
            retryable: false,
          },
        ],
      };
    }
  }

  private async checkPermission(input: ExecuteToolInput): Promise<
    ToolExecutionFailed | ToolExecutionBlocked | ToolExecutionCancelled | null
  > {
    if (!isGovernedToolCall(input.toolCall)) {
      return null;
    }

    const permissionRequest = createPermissionRequest({
      id: `permission_request_${input.toolCall.id}`,
      taskId: input.task.id,
      toolCall: input.toolCall,
      reason: input.executionContext?.permissionReason
        ?? `Tool ${input.toolCall.toolName} is marked as risky.`,
      metadata: {
        source: "tool-execution-boundary",
        workspaceId: input.workspace?.id ?? null,
        ...input.executionContext?.metadata,
      },
    });
    let decision;
    try {
      const permissionService = this.dependencies.permissionService
        ?? createPermissionServiceFromMode(input.config.permissionMode);
      decision = await permissionService.request(permissionRequest);
    } catch (error) {
      const cancellation = cancellationOutcome(input, null);
      if (cancellation !== null) {
        return cancellation;
      }
      return {
        status: "failed",
        toolResult: null,
        errors: [
          {
            owner: "permission",
            code: "permission_check_failed",
            message: error instanceof Error
              ? error.message
              : "Permission service failed.",
            metadata: {
              requestId: permissionRequest.id,
              toolCallId: input.toolCall.id,
              toolName: input.toolCall.toolName,
            },
            retryable: false,
          },
        ],
      };
    }

    const cancellation = cancellationOutcome(input, null);
    if (cancellation !== null) {
      return cancellation;
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
          owner: "permission",
          code: decision.code ?? "permission_denied",
          message: decision.reason,
          metadata: {
            requestId: decision.requestId,
            toolCallId: input.toolCall.id,
            toolName: input.toolCall.toolName,
          },
          retryable: false,
        },
      ],
    };
  }

  private async recordPolicyDecision(
    input: ExecuteToolInput,
    decision: PolicyDecision,
  ): Promise<ToolExecutionFailed | ToolExecutionCancelled | null> {
    const cancellationBeforeAudit = cancellationOutcome(input, null);
    if (cancellationBeforeAudit !== null) {
      return cancellationBeforeAudit;
    }
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

    const cancellationBeforeTelemetry = cancellationOutcome(input, null);
    if (cancellationBeforeTelemetry !== null) {
      return cancellationBeforeTelemetry;
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
  ): Promise<ToolExecutionFailed | ToolExecutionCancelled | null> {
    const cancellationBeforeAudit = cancellationOutcome(input, null);
    if (cancellationBeforeAudit !== null) {
      return cancellationBeforeAudit;
    }
    const auditError = await this.recordAudit(input, {
      id: `audit_permission_resolved_${input.toolCall.id}`,
      eventName: "permission.resolved",
      action: "permission.resolve",
      outcome: decision.status === "granted" ? "succeeded" : "blocked",
      payload: {
        requestId: decision.requestId,
        decisionStatus: decision.status,
        code: decision.code ?? null,
        permissionMode: input.config.permissionMode,
        toolCallId: input.toolCall.id,
        toolName: input.toolCall.toolName,
      },
    });
    if (auditError) {
      return auditError;
    }

    const cancellationBeforeTelemetry = cancellationOutcome(input, null);
    if (cancellationBeforeTelemetry !== null) {
      return cancellationBeforeTelemetry;
    }

    return this.recordTelemetry(input, {
      id: `telemetry_permission_resolved_${input.toolCall.id}`,
      eventName: "runtime.permission.resolved",
      dimensions: {
        decisionStatus: decision.status,
        code: decision.code ?? null,
        permissionMode: input.config.permissionMode,
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
  ): Promise<ToolExecutionFailed | ToolExecutionCancelled | null> {
    const cancellationBeforeRecord = cancellationOutcome(input, null);
    if (cancellationBeforeRecord !== null) {
      return cancellationBeforeRecord;
    }
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
      }), createToolObservabilityContext(input));
      return cancellationOutcome(input, null);
    } catch (error) {
      const cancellation = cancellationOutcome(input, null);
      if (cancellation !== null) {
        return cancellation;
      }
      if (input.config.audit !== "required") {
        return null;
      }

      return {
        status: "failed",
        toolResult: null,
        errors: [
          {
            owner: "audit",
            code: "audit_required_failed",
            message: error instanceof Error ? error.message : "Required audit recording failed.",
            metadata: {
              eventName: event.eventName,
              toolCallId: input.toolCall.id,
              toolName: input.toolCall.toolName,
            },
            retryable: false,
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
  ): Promise<ToolExecutionFailed | ToolExecutionCancelled | null> {
    const cancellationBeforeRecord = cancellationOutcome(input, null);
    if (cancellationBeforeRecord !== null) {
      return cancellationBeforeRecord;
    }
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
      }), createToolObservabilityContext(input));
      return cancellationOutcome(input, null);
    } catch (error) {
      const cancellation = cancellationOutcome(input, null);
      if (cancellation !== null) {
        return cancellation;
      }
      if (input.config.telemetry !== "required") {
        return null;
      }

      return {
        status: "failed",
        toolResult: null,
        errors: [
          {
            owner: "telemetry",
            code: "runtime_telemetry_required_failed",
            message: error instanceof Error ? error.message : "Required telemetry recording failed.",
            metadata: {
              eventName: event.eventName,
              toolCallId: input.toolCall.id,
              toolName: input.toolCall.toolName,
            },
            retryable: false,
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

function createToolObservabilityContext(input: ExecuteToolInput) {
  const interruption = input.invocation.interruption.interruption;
  return Object.freeze({
    purpose: "runtime" as const,
    signal: input.invocation.interruption.signal,
    deadlineAt: interruption?.kind === "operation_deadline"
      ? interruption.deadline.deadlineAt
      : null,
  });
}

function mapWorkspaceToPolicyWorkspace(workspace: WorkspaceContext | undefined): PolicyWorkspace | undefined {
  if (!workspace) {
    return undefined;
  }

  return {
    id: workspace.id,
    trustLevel: workspace.trustState,
    metadata: {
      name: workspace.name,
      rootRef: workspace.rootRef,
      source: workspace.source,
      policyRefs: workspace.policyRefs,
      ...workspace.metadata,
    },
  };
}

function isGovernedToolCall(toolCall: ToolCall): boolean {
  return toolCall.risk === "risky";
}

function cancellationOutcome(
  input: ExecuteToolInput,
  toolResult: ToolResult | null,
): ToolExecutionCancelled | ToolExecutionFailed | null {
  if (!input.invocation.interruption.signal.aborted) {
    return null;
  }

  const interruption = input.invocation.interruption.interruption;
  if (interruption?.kind === "run_cancellation") {
    return {
      status: "cancelled",
      toolResult,
      cancellation: interruption.cancellation,
    };
  }

  if (interruption?.kind === "operation_deadline") {
    return {
      status: "failed",
      toolResult,
      errors: [{
        owner: "tool",
        code: "tool_timeout",
        message: "Tool invocation exceeded its operation deadline.",
        retryable: false,
        metadata: {
          toolCallId: input.toolCall.id,
          toolName: input.toolCall.toolName,
          operationId: interruption.deadline.operationId,
          deadlineAt: interruption.deadline.deadlineAt,
        },
      }],
    };
  }

  return cancellationUnconfirmed(
    input,
    toolResult,
    "Tool invocation was aborted without trusted Run cancellation attribution.",
  );
}

function classifyToolCancellation(
  input: ExecuteToolInput,
  toolResult: ToolResult,
): ToolExecutionCancelled | ToolExecutionFailed | null {
  if (toolResult.error?.code === "tool_cancellation_unconfirmed") {
    return cancellationUnconfirmed(input, toolResult, toolResult.error.message);
  }

  if (toolResult.status !== "cancelled") {
    return null;
  }

  const exact = cancellationOutcome(input, toolResult);
  return exact ?? cancellationUnconfirmed(
    input,
    toolResult,
    "Tool returned cancelled without an active attributed Run cancellation.",
  );
}

function cancellationUnconfirmed(
  input: ExecuteToolInput,
  toolResult: ToolResult | null,
  message: string,
): ToolExecutionFailed {
  return {
    status: "failed",
    toolResult,
    errors: [{
      owner: "tool",
      code: "tool_cancellation_unconfirmed",
      message,
      retryable: false,
      metadata: {
        toolCallId: input.toolCall.id,
        toolName: input.toolCall.toolName,
        toolResultStatus: toolResult?.status ?? null,
      },
    }],
  };
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
    owner: "tool",
    code: input.code,
    message: input.message,
    retryable: false,
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
