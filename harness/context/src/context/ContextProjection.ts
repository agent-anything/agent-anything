import type { EvidenceRef } from "../evidence/EvidenceRef.js";
import type { ContextFailure } from "./ContextFailure.js";
import type { Context, ContextObservation } from "./Context.js";
import type { ContextMessage } from "./ContextMessage.js";

export type ContextProjectionPurpose = "model" | "workflow";

export interface ContextProjectionLimits {
  readonly maxMessages: number;
  readonly maxMessageLength: number;
  readonly maxObservations: number;
  readonly maxObservationBytes: number;
  readonly maxEvidenceRefs: number;
  readonly maxMetadataEntries: number;
}

export interface ContextProjectionRequest {
  readonly runId: string;
  readonly controllerIteration: number;
  readonly purpose: ContextProjectionPurpose;
  readonly limits: ContextProjectionLimits;
}

export interface ContextProjection<
  TObservation extends ContextObservation = ContextObservation,
> {
  readonly messages: readonly ContextMessage[];
  readonly observations: readonly TObservation[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ContextProjectorInput<
  TObservation extends ContextObservation,
> {
  readonly context: Context<TObservation>;
  readonly request: ContextProjectionRequest;
}

export interface ContextProjectorPort<
  TObservation extends ContextObservation,
  TProjectedObservation extends ContextObservation = TObservation,
> {
  project(
    input: ContextProjectorInput<TObservation>,
  ): ContextProjection<TProjectedObservation>;
}

export class ContextProjectionError extends Error {
  readonly failure: ContextFailure;

  constructor(failure: ContextFailure) {
    super(failure.message);
    this.name = "ContextProjectionError";
    this.failure = failure;
  }
}

export function snapshotContextProjection<
  TObservation extends ContextObservation,
>(input: {
  readonly projection: ContextProjection<TObservation>;
  readonly request: ContextProjectionRequest;
}): ContextProjection<TObservation> {
  const request = snapshotContextProjectionRequest(input.request);
  const projection = input.projection;
  if (!isRecord(projection)) {
    throw projectionError(
      "context_projection_invalid",
      "Context projector returned a non-object projection.",
    );
  }
  if (!Array.isArray(projection.messages)) {
    throw projectionError(
      "context_projection_invalid",
      "Context projection messages must be an array.",
    );
  }
  if (!Array.isArray(projection.observations)) {
    throw projectionError(
      "context_projection_invalid",
      "Context projection observations must be an array.",
    );
  }
  if (!Array.isArray(projection.evidenceRefs)) {
    throw projectionError(
      "context_projection_invalid",
      "Context projection Evidence references must be an array.",
    );
  }
  if (!isRecord(projection.metadata)) {
    throw projectionError(
      "context_projection_invalid",
      "Context projection metadata must be a record.",
    );
  }
  if (projection.messages.length > request.limits.maxMessages) {
    throw projectionLimitError("messages", request.limits.maxMessages);
  }
  if (projection.observations.length > request.limits.maxObservations) {
    throw projectionLimitError(
      "observations",
      request.limits.maxObservations,
    );
  }
  if (projection.evidenceRefs.length > request.limits.maxEvidenceRefs) {
    throw projectionLimitError(
      "evidenceRefs",
      request.limits.maxEvidenceRefs,
    );
  }
  if (
    Object.keys(projection.metadata).length >
      request.limits.maxMetadataEntries
  ) {
    throw projectionLimitError(
      "metadata",
      request.limits.maxMetadataEntries,
    );
  }

  const messages = projection.messages.map((message) => {
    if (
      !isRecord(message) ||
      typeof message.id !== "string" ||
      message.id.trim().length === 0 ||
      (message.role !== "system" &&
        message.role !== "user" &&
        message.role !== "assistant") ||
      typeof message.content !== "string" ||
      !isRecord(message.metadata)
    ) {
      throw projectionError(
        "context_projection_invalid",
        "Context projection contains an invalid message.",
      );
    }
    if (message.content.length > request.limits.maxMessageLength) {
      throw projectionLimitError(
        `message:${message.id}`,
        request.limits.maxMessageLength,
      );
    }
    assertMetadataEntryLimit(
      message.metadata,
      `message:${message.id}:metadata`,
      request.limits.maxMetadataEntries,
    );
    return Object.freeze({
      id: message.id,
      role: message.role,
      content: message.content,
      metadata: Object.freeze({ ...message.metadata }),
    });
  });

  const observations = projection.observations.map((observation) => {
    assertProjectedObservation(observation, request.runId);
    assertMetadataEntryLimit(
      observation.metadata,
      `observation:${observation.id}:metadata`,
      request.limits.maxMetadataEntries,
    );
    if (
      serializedByteLength(observation) >
        request.limits.maxObservationBytes
    ) {
      throw projectionLimitError(
        `observation:${observation.id}`,
        request.limits.maxObservationBytes,
      );
    }
    return Object.freeze({
      ...observation,
      metadata: Object.freeze({ ...observation.metadata }),
    }) as TObservation;
  });
  assertUniqueIdentities(
    observations.map((observation) => observation.id),
    "Observation",
  );

  const evidenceRefs = projection.evidenceRefs.map((reference) => {
    if (typeof reference !== "string" || reference.trim().length === 0) {
      throw projectionError(
        "context_projection_invalid",
        "Context projection contains an invalid Evidence reference.",
      );
    }
    return reference;
  });
  assertUniqueIdentities(evidenceRefs, "Evidence reference");
  assertUniqueIdentities(
    messages.map((message) => message.id),
    "message",
  );

  return Object.freeze({
    messages: Object.freeze(messages),
    observations: Object.freeze(observations),
    evidenceRefs: Object.freeze(evidenceRefs),
    metadata: Object.freeze({ ...projection.metadata }),
  });
}

export function snapshotContextProjectionRequest(
  request: ContextProjectionRequest,
): ContextProjectionRequest {
  if (!isRecord(request)) {
    throw projectionError(
      "context_projection_request_invalid",
      "Context projection request must be an object.",
    );
  }
  if (typeof request.runId !== "string" || request.runId.trim().length === 0) {
    throw projectionError(
      "context_projection_request_invalid",
      "Context projection request requires a Run identity.",
    );
  }
  if (
    !Number.isSafeInteger(request.controllerIteration) ||
    request.controllerIteration < 1
  ) {
    throw projectionError(
      "context_projection_request_invalid",
      "Context projection request requires a positive Controller iteration.",
    );
  }
  if (request.purpose !== "model" && request.purpose !== "workflow") {
    throw projectionError(
      "context_projection_request_invalid",
      "Context projection purpose is invalid.",
    );
  }
  if (!isRecord(request.limits)) {
    throw projectionError(
      "context_projection_request_invalid",
      "Context projection limits must be an object.",
    );
  }
  const limits: ContextProjectionLimits = Object.freeze({
    maxMessages: readLimit(request.limits.maxMessages, "maxMessages"),
    maxMessageLength: readLimit(
      request.limits.maxMessageLength,
      "maxMessageLength",
    ),
    maxObservations: readLimit(
      request.limits.maxObservations,
      "maxObservations",
    ),
    maxObservationBytes: readLimit(
      request.limits.maxObservationBytes,
      "maxObservationBytes",
    ),
    maxEvidenceRefs: readLimit(
      request.limits.maxEvidenceRefs,
      "maxEvidenceRefs",
    ),
    maxMetadataEntries: readLimit(
      request.limits.maxMetadataEntries,
      "maxMetadataEntries",
    ),
  });
  return Object.freeze({
    runId: request.runId,
    controllerIteration: request.controllerIteration,
    purpose: request.purpose,
    limits,
  });
}

function assertProjectedObservation(
  observation: ContextObservation,
  runId: string,
): void {
  if (
    !isRecord(observation) ||
    typeof observation.id !== "string" ||
    observation.id.trim().length === 0 ||
    observation.runId !== runId ||
    typeof observation.actionId !== "string" ||
    observation.actionId.trim().length === 0 ||
    typeof observation.kind !== "string" ||
    observation.kind.trim().length === 0 ||
    typeof observation.createdAt !== "string" ||
    !Number.isFinite(Date.parse(observation.createdAt)) ||
    new Date(observation.createdAt).toISOString() !== observation.createdAt ||
    !isRecord(observation.metadata)
  ) {
    throw projectionError(
      "context_projection_invalid",
      "Context projection contains an invalid or cross-Run Observation.",
    );
  }
}

function serializedByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("Value is not serializable.");
    }
    return new TextEncoder().encode(serialized).byteLength;
  } catch (error) {
    throw projectionError(
      "context_projection_invalid",
      "Context projection contains a non-serializable Observation.",
      error,
    );
  }
}

function readLimit(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw projectionError(
      "context_projection_request_invalid",
      `Context projection limit '${field}' must be a non-negative safe integer.`,
    );
  }
  return value as number;
}

function projectionLimitError(field: string, maximum: number): ContextProjectionError {
  return projectionError(
    "context_projection_limit_exceeded",
    `Context projection '${field}' exceeds its configured limit.`,
    undefined,
    { field, maximum },
  );
}

function assertMetadataEntryLimit(
  metadata: Readonly<Record<string, unknown>>,
  field: string,
  maximum: number,
): void {
  if (Object.keys(metadata).length > maximum) {
    throw projectionLimitError(field, maximum);
  }
}

function assertUniqueIdentities(
  values: readonly string[],
  kind: string,
): void {
  if (new Set(values).size !== values.length) {
    throw projectionError(
      "context_projection_invalid",
      `Context projection contains a duplicate ${kind} identity.`,
    );
  }
}

function projectionError(
  code: string,
  message: string,
  cause?: unknown,
  metadata: Readonly<Record<string, unknown>> = {},
): ContextProjectionError {
  return new ContextProjectionError(Object.freeze({
    code,
    message,
    retryable: false,
    metadata: Object.freeze({
      ...metadata,
      ...(cause instanceof Error ? { causeName: cause.name } : {}),
    }),
  }));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
