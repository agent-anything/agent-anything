import {
  isoDateTime,
  nonNegativeInteger,
  nullableToken,
  strictRecord,
  token,
} from "../ModelInteractionContractValidation.js";

export type ModelContinuationMechanism =
  | "response_chaining"
  | "provider_conversation";

export type ModelContinuationCapability =
  | { readonly supported: false }
  | {
      readonly supported: true;
      readonly mechanism: ModelContinuationMechanism;
      readonly supportsCompaction: boolean;
    };

export interface ModelContinuationRevisionRef {
  readonly id: string;
  readonly revision: string;
}

export interface ModelContinuationActiveContextRef {
  readonly id: string;
  readonly runId: string;
  readonly version: number;
}

export interface ModelOpaqueContinuationState {
  readonly kind: "opaque_provider_state";
  readonly handle: string;
  readonly sensitivity: "restricted";
}

export interface ModelContinuationRef {
  readonly id: string;
  readonly providerId: string;
  readonly model: string;
  readonly mechanism: ModelContinuationMechanism;
  readonly predecessor: {
    readonly continuationId: string;
    readonly responseId: string;
  } | null;
  readonly branchId: string;
  readonly requestId: string;
  readonly responseId: string;
  readonly activeContext: ModelContinuationActiveContextRef;
  readonly protocol: ModelContinuationRevisionRef;
  readonly toolExposure: ModelContinuationRevisionRef;
  readonly policy: ModelContinuationRevisionRef;
  readonly state: ModelOpaqueContinuationState;
  readonly createdAt: string;
}

export type ModelContinuationIncompatibilityReason =
  | "provider_changed"
  | "model_changed"
  | "predecessor_changed"
  | "branch_changed"
  | "active_context_changed"
  | "protocol_changed"
  | "tool_exposure_changed"
  | "policy_changed";

export type ModelContinuationCompatibility =
  | { readonly kind: "compatible" }
  | {
      readonly kind: "incompatible";
      readonly reason: ModelContinuationIncompatibilityReason;
    };

export interface ModelCompactionRef {
  readonly id: string;
  readonly continuationId: string;
  readonly providerId: string;
  readonly model: string;
  readonly requestId: string;
  readonly responseId: string;
  readonly state: ModelOpaqueContinuationState;
  readonly createdAt: string;
}

export type ModelContinuationOutcome =
  | {
      readonly kind: "reused";
      readonly continuation: ModelContinuationRef;
    }
  | {
      readonly kind: "reset";
      readonly previousContinuationId: string | null;
      readonly reason: ModelContinuationIncompatibilityReason | "provider_rejected";
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "unsupported" | "missing";
    }
  | {
      readonly kind: "rejected";
      readonly continuationId: string;
      readonly providerCode: string | null;
    }
  | {
      readonly kind: "cancelled";
      readonly continuationId: string | null;
    }
  | {
      readonly kind: "failed";
      readonly continuationId: string | null;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "compacted";
      readonly compaction: ModelCompactionRef;
    };

export function snapshotModelContinuationCapability(
  input: ModelContinuationCapability,
): ModelContinuationCapability {
  strictRecord(input, "ModelContinuationCapability", [
    "supported", "mechanism", "supportsCompaction",
  ]);
  if (input.supported === false) {
    strictRecord(input, "ModelContinuationCapability", ["supported"]);
    return Object.freeze({ supported: false });
  }
  if (input.supported !== true || !isMechanism(input.mechanism)) {
    throw new TypeError("ModelContinuationCapability is invalid.");
  }
  strictRecord(input, "ModelContinuationCapability", [
    "supported", "mechanism", "supportsCompaction",
  ]);
  if (typeof input.supportsCompaction !== "boolean") {
    throw new TypeError("ModelContinuationCapability.supportsCompaction must be boolean.");
  }
  return Object.freeze({
    supported: true,
    mechanism: input.mechanism,
    supportsCompaction: input.supportsCompaction,
  });
}

export function snapshotModelContinuationRef(
  input: ModelContinuationRef,
): ModelContinuationRef {
  strictRecord(input, "ModelContinuationRef", [
    "id", "providerId", "model", "mechanism", "predecessor", "branchId",
    "requestId", "responseId", "activeContext", "protocol", "toolExposure",
    "policy", "state", "createdAt",
  ]);
  if (!isMechanism(input.mechanism)) {
    throw new TypeError("ModelContinuationRef.mechanism is invalid.");
  }
  return Object.freeze({
    id: token(input.id, "ModelContinuationRef.id"),
    providerId: token(input.providerId, "ModelContinuationRef.providerId"),
    model: token(input.model, "ModelContinuationRef.model"),
    mechanism: input.mechanism,
    predecessor: input.predecessor === null
      ? null
      : snapshotPredecessor(input.predecessor),
    branchId: token(input.branchId, "ModelContinuationRef.branchId"),
    requestId: token(input.requestId, "ModelContinuationRef.requestId"),
    responseId: token(input.responseId, "ModelContinuationRef.responseId"),
    activeContext: snapshotActiveContext(input.activeContext),
    protocol: snapshotRevisionRef(input.protocol, "ModelContinuationRef.protocol"),
    toolExposure: snapshotRevisionRef(
      input.toolExposure,
      "ModelContinuationRef.toolExposure",
    ),
    policy: snapshotRevisionRef(input.policy, "ModelContinuationRef.policy"),
    state: snapshotOpaqueState(input.state, "ModelContinuationRef.state"),
    createdAt: isoDateTime(input.createdAt, "ModelContinuationRef.createdAt"),
  });
}

export function snapshotModelContinuationCompatibility(
  input: ModelContinuationCompatibility,
): ModelContinuationCompatibility {
  strictRecord(input, "ModelContinuationCompatibility", ["kind", "reason"]);
  if (input.kind === "compatible") {
    strictRecord(input, "ModelContinuationCompatibility", ["kind"]);
    return Object.freeze({ kind: "compatible" });
  }
  if (input.kind !== "incompatible" || !isIncompatibilityReason(input.reason)) {
    throw new TypeError("ModelContinuationCompatibility is invalid.");
  }
  return Object.freeze({ kind: "incompatible", reason: input.reason });
}

export function snapshotModelContinuationOutcome(
  input: ModelContinuationOutcome,
): ModelContinuationOutcome {
  strictRecord(input, "ModelContinuationOutcome", [
    "kind", "continuation", "previousContinuationId", "reason",
    "continuationId", "providerCode", "code", "message", "compaction",
  ]);
  switch (input.kind) {
    case "reused":
      strictRecord(input, "ModelContinuationOutcome", ["kind", "continuation"]);
      return Object.freeze({
        kind: "reused",
        continuation: snapshotModelContinuationRef(input.continuation),
      });
    case "reset":
      strictRecord(input, "ModelContinuationOutcome", [
        "kind", "previousContinuationId", "reason",
      ]);
      if (
        input.reason !== "provider_rejected" &&
        !isIncompatibilityReason(input.reason)
      ) {
        throw new TypeError("ModelContinuation reset reason is invalid.");
      }
      return Object.freeze({
        kind: "reset",
        previousContinuationId: nullableToken(
          input.previousContinuationId,
          "ModelContinuationOutcome.previousContinuationId",
        ),
        reason: input.reason,
      });
    case "unavailable":
      strictRecord(input, "ModelContinuationOutcome", ["kind", "reason"]);
      if (input.reason !== "unsupported" && input.reason !== "missing") {
        throw new TypeError("ModelContinuation unavailable reason is invalid.");
      }
      return Object.freeze({ kind: "unavailable", reason: input.reason });
    case "rejected":
      strictRecord(input, "ModelContinuationOutcome", [
        "kind", "continuationId", "providerCode",
      ]);
      return Object.freeze({
        kind: "rejected",
        continuationId: token(
          input.continuationId,
          "ModelContinuationOutcome.continuationId",
        ),
        providerCode: nullableToken(
          input.providerCode,
          "ModelContinuationOutcome.providerCode",
        ),
      });
    case "cancelled":
      strictRecord(input, "ModelContinuationOutcome", ["kind", "continuationId"]);
      return Object.freeze({
        kind: "cancelled",
        continuationId: nullableToken(
          input.continuationId,
          "ModelContinuationOutcome.continuationId",
        ),
      });
    case "failed":
      strictRecord(input, "ModelContinuationOutcome", [
        "kind", "continuationId", "code", "message",
      ]);
      return Object.freeze({
        kind: "failed",
        continuationId: nullableToken(
          input.continuationId,
          "ModelContinuationOutcome.continuationId",
        ),
        code: token(input.code, "ModelContinuationOutcome.code"),
        message: token(input.message, "ModelContinuationOutcome.message"),
      });
    case "compacted":
      strictRecord(input, "ModelContinuationOutcome", ["kind", "compaction"]);
      return Object.freeze({
        kind: "compacted",
        compaction: snapshotCompactionRef(input.compaction),
      });
    default:
      throw new TypeError("ModelContinuationOutcome kind is invalid.");
  }
}

function snapshotCompactionRef(input: ModelCompactionRef): ModelCompactionRef {
  strictRecord(input, "ModelCompactionRef", [
    "id", "continuationId", "providerId", "model", "requestId", "responseId",
    "state", "createdAt",
  ]);
  return Object.freeze({
    id: token(input.id, "ModelCompactionRef.id"),
    continuationId: token(input.continuationId, "ModelCompactionRef.continuationId"),
    providerId: token(input.providerId, "ModelCompactionRef.providerId"),
    model: token(input.model, "ModelCompactionRef.model"),
    requestId: token(input.requestId, "ModelCompactionRef.requestId"),
    responseId: token(input.responseId, "ModelCompactionRef.responseId"),
    state: snapshotOpaqueState(input.state, "ModelCompactionRef.state"),
    createdAt: isoDateTime(input.createdAt, "ModelCompactionRef.createdAt"),
  });
}

function snapshotPredecessor(
  input: NonNullable<ModelContinuationRef["predecessor"]>,
): NonNullable<ModelContinuationRef["predecessor"]> {
  strictRecord(input, "ModelContinuationRef.predecessor", [
    "continuationId", "responseId",
  ]);
  return Object.freeze({
    continuationId: token(
      input.continuationId,
      "ModelContinuationRef.predecessor.continuationId",
    ),
    responseId: token(input.responseId, "ModelContinuationRef.predecessor.responseId"),
  });
}

function snapshotActiveContext(
  input: ModelContinuationActiveContextRef,
): ModelContinuationActiveContextRef {
  strictRecord(input, "ModelContinuationRef.activeContext", [
    "id", "runId", "version",
  ]);
  return Object.freeze({
    id: token(input.id, "ModelContinuationRef.activeContext.id"),
    runId: token(input.runId, "ModelContinuationRef.activeContext.runId"),
    version: nonNegativeInteger(
      input.version,
      "ModelContinuationRef.activeContext.version",
    ),
  });
}

function snapshotRevisionRef(
  input: ModelContinuationRevisionRef,
  path: string,
): ModelContinuationRevisionRef {
  strictRecord(input, path, ["id", "revision"]);
  return Object.freeze({
    id: token(input.id, `${path}.id`),
    revision: token(input.revision, `${path}.revision`),
  });
}

function snapshotOpaqueState(
  input: ModelOpaqueContinuationState,
  path: string,
): ModelOpaqueContinuationState {
  strictRecord(input, path, ["kind", "handle", "sensitivity"]);
  if (
    input.kind !== "opaque_provider_state" ||
    input.sensitivity !== "restricted"
  ) {
    throw new TypeError(`${path} must remain restricted opaque Provider state.`);
  }
  return Object.freeze({
    kind: "opaque_provider_state",
    handle: token(input.handle, `${path}.handle`),
    sensitivity: "restricted",
  });
}

function isMechanism(value: unknown): value is ModelContinuationMechanism {
  return value === "response_chaining" || value === "provider_conversation";
}

function isIncompatibilityReason(
  value: unknown,
): value is ModelContinuationIncompatibilityReason {
  return value === "provider_changed" || value === "model_changed" ||
    value === "predecessor_changed" || value === "branch_changed" ||
    value === "active_context_changed" || value === "protocol_changed" ||
    value === "tool_exposure_changed" || value === "policy_changed";
}
