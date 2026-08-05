import type { ObservationBase } from "@agent-anything/agent-core/action";
import type { ActionExecutionFailure } from "@agent-anything/action-execution";
import type { RunObservation } from "@agent-anything/agent-runtime/run";
import type {
  ContextProjection,
  ContextProjectorInput,
  ContextProjectorPort,
} from "@agent-anything/context/context";
import type { ToolResult, ToolResultError } from "@agent-anything/tools";

const SENSITIVE_KEY =
  /(?:authorization|credential|password|secret|token|api[-_]?key)/i;
const MAX_PROJECTED_VALUE_DEPTH = 6;
const MAX_PROJECTED_OBJECT_ENTRIES = 100;
const MAX_PROJECTED_ARRAY_ITEMS = 100;
const MAX_PROJECTED_STRING_LENGTH = 8_000;

export function createHelarcContextProjector(): ContextProjectorPort<
  RunObservation,
  RunObservation
> {
  return Object.freeze({
    project({
      context,
      request,
    }: ContextProjectorInput<RunObservation>): ContextProjection<RunObservation> {
      const observations = context.observations
        .slice(-request.limits.maxObservations)
        .map((observation) =>
          fitObservation(
            projectObservation(observation, request.limits.maxObservationBytes),
            request.limits.maxObservationBytes,
          ),
        );
      return Object.freeze({
        messages: Object.freeze(
          context.messages
            .slice(-request.limits.maxMessages)
            .map((message) =>
              Object.freeze({
                id: message.id,
                role: message.role,
                content: truncate(
                  message.content,
                  request.limits.maxMessageLength,
                ),
                metadata: Object.freeze({}),
              }),
            ),
        ),
        observations: Object.freeze(observations),
        evidenceRefs: Object.freeze(
          context.evidenceRefs.slice(-request.limits.maxEvidenceRefs),
        ),
        metadata: Object.freeze({}),
      });
    },
  });
}

function projectObservation(
  observation: RunObservation,
  maxObservationBytes: number,
): RunObservation {
  const base = observationBase(observation);
  const messageLimit = Math.min(
    MAX_PROJECTED_STRING_LENGTH,
    Math.max(0, Math.floor(maxObservationBytes / 4)),
  );
  switch (observation.kind) {
    case "plan_update":
      return Object.freeze({
        ...base,
        kind: observation.kind,
        result: sanitizeValue(observation.result),
      }) as RunObservation;
    case "tool_result":
      return Object.freeze({
        ...base,
        kind: observation.kind,
        result: projectToolResult(observation.result, messageLimit),
      });
    case "action_denied":
      return Object.freeze({
        ...base,
        kind: observation.kind,
        owner: observation.owner,
        code: observation.code,
        message: truncate(observation.message, messageLimit),
      });
    case "action_failure":
      return Object.freeze({
        ...base,
        kind: observation.kind,
        failure: projectActionFailure(observation.failure, messageLimit),
      });
    case "action_rejected":
      return Object.freeze({
        ...base,
        kind: observation.kind,
        code: observation.code,
        message: truncate(observation.message, messageLimit),
      });
    case "approval_declined":
      return Object.freeze({
        ...base,
        kind: observation.kind,
        requestId: observation.requestId,
        category: observation.category,
        reason:
          observation.reason === null
            ? null
            : truncate(observation.reason, messageLimit),
      });
    case "approval_policy_rejected":
      return Object.freeze({
        ...base,
        kind: observation.kind,
        requestId: observation.requestId,
        category: observation.category,
        code: observation.code,
        message: truncate(observation.message, messageLimit),
      });
    case "approval_limit_reached":
      return Object.freeze({
        ...base,
        kind: observation.kind,
        requestId: observation.requestId,
        category: observation.category,
        limit: observation.limit,
        current: observation.current,
        maximum: observation.maximum,
      });
    case "approval_review_failed":
      return Object.freeze({
        ...base,
        kind: observation.kind,
        requestId: observation.requestId,
        category: observation.category,
        code: observation.code,
        message: truncate(observation.message, messageLimit),
        retryable: observation.retryable,
      });
    case "approval_application_failed":
      return Object.freeze({
        ...base,
        kind: observation.kind,
        requestId: observation.requestId,
        category: observation.category,
        scope: observation.scope,
        code: observation.code,
        message: truncate(observation.message, messageLimit),
      });
    case "permissions_granted":
      return Object.freeze({
        ...base,
        kind: observation.kind,
        requestId: observation.requestId,
        category: observation.category,
        scope: observation.scope,
        summary: Object.freeze({ ...observation.summary }),
      });
  }
}

function observationBase(
  observation: RunObservation,
): ObservationBase {
  const actionName = observation.metadata.actionName;
  return Object.freeze({
    id: observation.id,
    runId: observation.runId,
    actionId: observation.actionId,
    kind: observation.kind,
    createdAt: observation.createdAt,
    metadata: Object.freeze({
      ...(typeof actionName === "string" ? { actionName } : {}),
    }),
  });
}

function projectToolResult(
  result: ToolResult,
  messageLimit: number,
): ToolResult {
  const base = {
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    metadata: Object.freeze({}),
  };
  switch (result.status) {
    case "succeeded":
      return Object.freeze({
        ...base,
        status: result.status,
        output: sanitizeValue(result.output),
      }) as ToolResult;
    case "partial":
      return Object.freeze({
        ...base,
        status: result.status,
        output: sanitizeValue(result.output),
        outputUsability: result.outputUsability,
        error: projectToolError(result.error, messageLimit),
      }) as ToolResult;
    case "failed":
    case "timeout":
      return Object.freeze({
        ...base,
        status: result.status,
        error: projectToolError(result.error, messageLimit),
      });
  }
}

function projectToolError(
  error: ToolResultError,
  messageLimit: number,
): ToolResultError {
  return Object.freeze({
    code: error.code,
    message: truncate(error.message, messageLimit),
    metadata: Object.freeze({}),
  });
}

function projectActionFailure(
  cause: ActionExecutionFailure,
  messageLimit: number,
): ActionExecutionFailure {
  const failure = {
    code: cause.failure.code,
    message: truncate(cause.failure.message, messageLimit),
    retryable: cause.failure.retryable,
    metadata: Object.freeze({}),
  };
  return cause.kind === "sandbox"
    ? Object.freeze({
        kind: cause.kind,
        failure: Object.freeze({
          ...failure,
          effectState: cause.failure.effectState,
        }),
      })
    : Object.freeze({
        kind: cause.kind,
        failure: Object.freeze(failure),
      }) as ActionExecutionFailure;
}

function fitObservation(
  observation: RunObservation,
  maximumBytes: number,
): RunObservation {
  if (
    observation.kind !== "tool_result" ||
    serializedByteLength(observation) <= maximumBytes ||
    (observation.result.status !== "succeeded" &&
      observation.result.status !== "partial")
  ) {
    return observation;
  }
  const output = Object.freeze({
    truncated: true,
    summary: "Tool output omitted because it exceeded the Context projection limit.",
  });
  return Object.freeze({
    ...observation,
    result: Object.freeze({
      ...observation.result,
      output,
    }),
  }) as RunObservation;
}

function sanitizeValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    return truncate(value, MAX_PROJECTED_STRING_LENGTH);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (depth >= MAX_PROJECTED_VALUE_DEPTH) {
    return "[Depth limit]";
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return Object.freeze(
      value
        .slice(0, MAX_PROJECTED_ARRAY_ITEMS)
        .map((item) => sanitizeValue(item, depth + 1, seen)),
    );
  }
  const projected: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(
    0,
    MAX_PROJECTED_OBJECT_ENTRIES,
  )) {
    projected[key] = SENSITIVE_KEY.test(key)
      ? "[REDACTED]"
      : sanitizeValue(item, depth + 1, seen);
  }
  return Object.freeze(projected);
}

function truncate(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }
  if (maximumLength <= 3) {
    return ".".repeat(maximumLength);
  }
  return `${value.slice(0, maximumLength - 3)}...`;
}

function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
