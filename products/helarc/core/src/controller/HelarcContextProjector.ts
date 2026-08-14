import type { RunObservation } from "@agent-anything/agent-runtime/run";
import type {
  ContextProjection,
  ContextProjectorInput,
  ContextProjectorPort,
} from "@agent-anything/context/context";

const SENSITIVE_KEY =
  /(?:authorization|credential|password|secret|token|api[-_]?key)/i;
const MAX_PROJECTED_VALUE_DEPTH = 6;
const MAX_PROJECTED_OBJECT_ENTRIES = 64;
const MAX_PROJECTED_ARRAY_ITEMS = 64;
const MAX_PROJECTED_STRING_LENGTH = 8_000;

export function createHelarcContextProjector(): ContextProjectorPort<
  RunObservation,
  RunObservation
> {
  return Object.freeze({
    project({ context, request }: ContextProjectorInput<RunObservation>): ContextProjection<RunObservation> {
      return Object.freeze({
        messages: Object.freeze(
          context.messages
            .slice(-request.limits.maxMessages)
            .map((message) => Object.freeze({
              id: message.id,
              role: message.role,
              content: truncate(message.content, request.limits.maxMessageLength),
              metadata: Object.freeze({}),
            })),
        ),
        observations: Object.freeze(
          context.observations
            .slice(-request.limits.maxObservations)
            .map((observation) => projectObservation(
              observation,
              request.limits.maxObservationBytes,
            )),
        ),
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
  maximumBytes: number,
): RunObservation {
  const actionName = observation.metadata.actionName;
  const projected = Object.freeze({
    id: observation.id,
    runId: observation.runId,
    actionId: observation.actionId,
    kind: observation.kind,
    createdAt: observation.createdAt,
    owner: observation.owner,
    runAction: observation.runAction,
    lowerRefs: Object.freeze(observation.lowerRefs.map((reference) =>
      Object.freeze({ ...reference })
    )),
    payload: sanitizeValue(observation.payload) as RunObservation["payload"],
    metadata: Object.freeze({
      ...(typeof actionName === "string" ? { actionName } : {}),
    }),
  });
  if (serializedByteLength(projected) <= maximumBytes) return projected;
  return Object.freeze({
    ...projected,
    payload: truncatePayload(projected.payload),
  });
}

function truncatePayload(payload: RunObservation["payload"]): RunObservation["payload"] {
  if (payload.kind === "operation") {
    const result = payload.result;
    const boundedResult = result.status === "succeeded"
      ? Object.freeze({
          ...result,
          output: Object.freeze({
            truncated: true,
            summary: "Operation output exceeded the Context projection limit.",
          }),
          metadata: Object.freeze({}),
        })
      : result.status === "partial"
        ? Object.freeze({
            ...result,
            output: Object.freeze({
              truncated: true,
              summary: "Partial Operation output exceeded the Context projection limit.",
            }),
            failure: projectFailure(result.failure),
            metadata: Object.freeze({}),
          })
        : Object.freeze({
            ...result,
            failure: projectFailure(result.failure),
            metadata: Object.freeze({}),
          });
    return Object.freeze({
      kind: "operation" as const,
      result: boundedResult,
      toolResult: null,
    });
  }
  if (payload.kind === "interaction") {
    return Object.freeze({
      ...payload,
      value: Object.freeze({
        truncated: true,
        summary: "Interaction value exceeded the Context projection limit.",
      }),
    });
  }
  return payload;
}

function projectFailure<T extends {
  readonly owner: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}>(failure: T): T {
  return Object.freeze({
    ...failure,
    message: truncate(failure.message, 1_000),
    metadata: Object.freeze({}),
  });
}

function sanitizeValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") return truncate(value, MAX_PROJECTED_STRING_LENGTH);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (depth >= MAX_PROJECTED_VALUE_DEPTH) return "[Depth limit]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value
        .slice(0, MAX_PROJECTED_ARRAY_ITEMS)
        .map((item) => sanitizeValue(item, depth + 1, seen)));
    }
    const projected: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_PROJECTED_OBJECT_ENTRIES)) {
      projected[key] = SENSITIVE_KEY.test(key)
        ? "[REDACTED]"
        : sanitizeValue(item, depth + 1, seen);
    }
    return Object.freeze(projected);
  } finally {
    seen.delete(value);
  }
}

function truncate(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  if (maximumLength <= 3) return ".".repeat(maximumLength);
  return `${value.slice(0, maximumLength - 3)}...`;
}

function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
