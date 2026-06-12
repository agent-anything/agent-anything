import type { Observation } from "../context/index.js";
import type { AgentTask } from "../task/index.js";
import type { Evidence, EvidenceBuilderPort } from "../../evidence/index.js";
import {
  createAllowAllPolicyPort,
  type PolicyPort,
} from "../../governance/index.js";
import {
  createPermissionRequest,
  createPermissionServiceFromMode,
  type PermissionService,
} from "../../permission/index.js";
import type { ToolCall, ToolRegistry, ToolResult } from "../../tools/index.js";
import type { RuntimeError } from "./RuntimeError.js";
import type { RuntimeOptions } from "./RuntimeOptions.js";

export interface ToolExecutionBoundaryDependencies {
  toolRegistry: ToolRegistry;
  evidenceBuilder: EvidenceBuilderPort;
  policyPort?: PolicyPort;
  permissionService?: PermissionService;
}

export interface ExecuteToolInput {
  task: AgentTask;
  toolCall: ToolCall;
  options: RuntimeOptions;
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
        risk: input.toolCall.risk,
        target: {
          kind: "tool",
          name: input.toolCall.toolName,
          resource: input.toolCall.id,
        },
        metadata: {
          source: "tool-execution-boundary",
        },
      });

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
