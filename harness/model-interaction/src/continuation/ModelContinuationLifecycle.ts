import type {
  ModelCompactionRef,
  ModelContinuationActiveContextRef,
  ModelContinuationCapability,
  ModelContinuationCompatibility,
  ModelContinuationIncompatibilityReason,
  ModelContinuationOutcome,
  ModelContinuationRef,
  ModelContinuationRevisionRef,
  ModelOpaqueContinuationState,
} from "./ModelContinuation.js";
import {
  snapshotModelContinuationCapability,
  snapshotModelContinuationOutcome,
  snapshotModelContinuationRef,
} from "./ModelContinuation.js";

export interface ModelContinuationRequestLineage {
  readonly providerId: string;
  readonly model: string;
  readonly branchId: string;
  readonly requestId: string;
  readonly activeContext: ModelContinuationActiveContextRef;
  readonly protocol: ModelContinuationRevisionRef;
  readonly toolExposureContent: ModelContinuationRevisionRef;
  readonly policy: ModelContinuationRevisionRef;
}

export interface ModelContinuationPreparation {
  readonly lineage: ModelContinuationRequestLineage;
  readonly continuation: ModelContinuationRef | null;
  readonly outcome: ModelContinuationOutcome;
}

export type ModelContinuationStoreCommitResult =
  | { readonly kind: "committed" }
  | { readonly kind: "conflict" };

export interface ModelContinuationStore {
  load(branchId: string): Promise<ModelContinuationRef | null>;
  commit(input: {
    readonly branchId: string;
    readonly expectedContinuationId: string | null;
    readonly continuation: ModelContinuationRef;
  }): Promise<ModelContinuationStoreCommitResult>;
  clear(input: {
    readonly branchId: string;
    readonly expectedContinuationId: string;
  }): Promise<ModelContinuationStoreCommitResult>;
}

export interface ModelContinuationSafeEvent {
  readonly branchId: string;
  readonly requestId: string;
  readonly kind: ModelContinuationOutcome["kind"];
  readonly reason: string | null;
  readonly occurredAt: string;
}

export interface ModelContinuationEventSink {
  publish(event: ModelContinuationSafeEvent): void | Promise<void>;
}

export type ModelCompactionCallResult =
  | {
      readonly kind: "succeeded";
      readonly compactionId: string;
      readonly requestId: string;
      readonly responseId: string;
      readonly state: ModelOpaqueContinuationState;
    }
  | { readonly kind: "unavailable" }
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "failed";
      readonly code: string;
      readonly message: string;
    };

export interface ModelContinuationCompactor {
  compact(input: {
    readonly continuation: ModelContinuationRef;
    readonly signal: AbortSignal;
  }): Promise<ModelCompactionCallResult>;
}

export interface ModelContinuationLifecycleInput {
  readonly store?: ModelContinuationStore;
  readonly events?: ModelContinuationEventSink;
  readonly now?: () => string;
  readonly createContinuationId?: (input: {
    readonly branchId: string;
    readonly requestId: string;
    readonly responseId: string;
  }) => string;
  readonly compactor?: ModelContinuationCompactor;
}

export class ModelContinuationLifecycle {
  private readonly store: ModelContinuationStore;
  private readonly events: ModelContinuationEventSink;
  private readonly now: () => string;
  private readonly createContinuationId: NonNullable<
    ModelContinuationLifecycleInput["createContinuationId"]
  >;
  private readonly compactor: ModelContinuationCompactor | null;

  constructor(input: ModelContinuationLifecycleInput = {}) {
    this.store = input.store ?? createInMemoryModelContinuationStore();
    this.events = input.events ?? Object.freeze({ publish() {} });
    this.now = input.now ?? (() => new Date().toISOString());
    this.createContinuationId = input.createContinuationId ?? ((value) =>
      `${value.branchId}:continuation:${value.requestId}:${value.responseId}`);
    this.compactor = input.compactor ?? null;
  }

  async prepare(input: {
    readonly capability: ModelContinuationCapability;
    readonly lineage: ModelContinuationRequestLineage;
  }): Promise<ModelContinuationPreparation> {
    const capability = snapshotModelContinuationCapability(input.capability);
    const lineage = snapshotLineage(input.lineage);
    if (!capability.supported) {
      return this.preparation(lineage, null, {
        kind: "unavailable",
        reason: "unsupported",
      });
    }

    let candidate: ModelContinuationRef | null;
    try {
      const loaded = await this.store.load(lineage.branchId);
      candidate = loaded === null ? null : snapshotModelContinuationRef(loaded);
    } catch {
      return this.preparation(lineage, null, {
        kind: "failed",
        continuationId: null,
        code: "continuation_store_load_failed",
        message: "Continuation state could not be loaded.",
      });
    }
    if (candidate === null) {
      return this.preparation(lineage, null, {
        kind: "unavailable",
        reason: "missing",
      });
    }

    const compatibility = checkModelContinuationCompatibility(
      candidate,
      lineage,
      capability.mechanism,
    );
    if (compatibility.kind === "incompatible") {
      const cleared = await this.clearCandidate(candidate, lineage);
      if (!cleared) {
        return this.preparation(lineage, null, {
          kind: "failed",
          continuationId: candidate.id,
          code: "continuation_store_conflict",
          message: "Incompatible continuation state changed before reset.",
        });
      }
      return this.preparation(lineage, null, {
        kind: "reset",
        previousContinuationId: candidate.id,
        reason: compatibility.reason,
      });
    }
    return this.preparation(lineage, candidate, {
      kind: "reused",
      continuation: candidate,
    });
  }

  async advance(input: {
    readonly preparation: ModelContinuationPreparation;
    readonly mechanism: Extract<ModelContinuationCapability, { readonly supported: true }>["mechanism"];
    readonly responseId: string;
    readonly state: ModelOpaqueContinuationState;
  }): Promise<ModelContinuationOutcome> {
    const responseId = requiredToken(input.responseId, "responseId");
    const lineage = snapshotLineage(input.preparation.lineage);
    const previous = input.preparation.continuation;
    const continuation = snapshotModelContinuationRef({
      id: requiredToken(this.createContinuationId({
        branchId: lineage.branchId,
        requestId: lineage.requestId,
        responseId,
      }), "continuationId"),
      providerId: lineage.providerId,
      model: lineage.model,
      mechanism: input.mechanism,
      predecessor: previous === null
        ? null
        : Object.freeze({
            continuationId: previous.id,
            responseId: previous.responseId,
          }),
      branchId: lineage.branchId,
      requestId: lineage.requestId,
      responseId,
      activeContext: lineage.activeContext,
      protocol: lineage.protocol,
      toolExposureContent: lineage.toolExposureContent,
      policy: lineage.policy,
      state: input.state,
      createdAt: this.timestamp(),
    });
    try {
      const result = await this.store.commit({
        branchId: lineage.branchId,
        expectedContinuationId: previous?.id ?? null,
        continuation,
      });
      if (result.kind === "conflict") {
        return this.record(lineage, {
          kind: "failed",
          continuationId: previous?.id ?? null,
          code: "continuation_store_conflict",
          message: "Continuation state changed before advancement.",
        });
      }
    } catch {
      return this.record(lineage, {
        kind: "failed",
        continuationId: previous?.id ?? null,
        code: "continuation_store_commit_failed",
        message: "Continuation state could not be committed.",
      });
    }
    return this.record(lineage, { kind: "advanced", continuation });
  }

  async rejectAndReset(
    preparation: ModelContinuationPreparation,
    providerCode: string | null,
  ): Promise<ModelContinuationOutcome> {
    const lineage = snapshotLineage(preparation.lineage);
    const current = preparation.continuation;
    if (current === null) {
      return this.record(lineage, {
        kind: "failed",
        continuationId: null,
        code: "continuation_rejection_uncorrelated",
        message: "Provider rejection has no correlated continuation state.",
      });
    }
    await this.record(lineage, {
      kind: "rejected",
      continuationId: current.id,
      providerCode,
    });
    if (!(await this.clearCandidate(current, lineage))) {
      return this.record(lineage, {
        kind: "failed",
        continuationId: current.id,
        code: "continuation_store_conflict",
        message: "Rejected continuation state changed before reset.",
      });
    }
    return this.record(lineage, {
      kind: "reset",
      previousContinuationId: current.id,
      reason: "provider_rejected",
    });
  }

  cancelled(preparation: ModelContinuationPreparation): Promise<ModelContinuationOutcome> {
    return this.record(preparation.lineage, {
      kind: "cancelled",
      continuationId: preparation.continuation?.id ?? null,
    });
  }

  failed(
    preparation: ModelContinuationPreparation,
    code: string,
    message: string,
  ): Promise<ModelContinuationOutcome> {
    return this.record(preparation.lineage, {
      kind: "failed",
      continuationId: preparation.continuation?.id ?? null,
      code,
      message,
    });
  }

  async compact(input: {
    readonly branchId: string;
    readonly signal: AbortSignal;
  }): Promise<ModelContinuationOutcome> {
    const branchId = requiredToken(input.branchId, "branchId");
    let current: ModelContinuationRef | null;
    try {
      const loaded = await this.store.load(branchId);
      current = loaded === null ? null : snapshotModelContinuationRef(loaded);
    } catch {
      return standaloneOutcome(branchId, "compaction", {
        kind: "failed",
        continuationId: null,
        code: "continuation_store_load_failed",
        message: "Continuation state could not be loaded for compaction.",
      }, this.events, this.timestamp());
    }
    if (current === null || this.compactor === null) {
      return standaloneOutcome(branchId, "compaction", {
        kind: "unavailable",
        reason: current === null ? "missing" : "unsupported",
      }, this.events, this.timestamp());
    }
    if (input.signal.aborted) {
      return standaloneOutcome(branchId, current.requestId, {
        kind: "cancelled",
        continuationId: current.id,
      }, this.events, this.timestamp());
    }

    let result: ModelCompactionCallResult;
    try {
      result = await this.compactor.compact({ continuation: current, signal: input.signal });
    } catch {
      result = {
        kind: "failed",
        code: "continuation_compaction_failed",
        message: "Continuation compaction failed.",
      };
    }
    if (result.kind === "unavailable") {
      return standaloneOutcome(branchId, current.requestId, {
        kind: "unavailable",
        reason: "unsupported",
      }, this.events, this.timestamp());
    }
    if (result.kind === "cancelled" || input.signal.aborted) {
      return standaloneOutcome(branchId, current.requestId, {
        kind: "cancelled",
        continuationId: current.id,
      }, this.events, this.timestamp());
    }
    if (result.kind === "failed") {
      return standaloneOutcome(branchId, current.requestId, {
        kind: "failed",
        continuationId: current.id,
        code: result.code,
        message: result.message,
      }, this.events, this.timestamp());
    }

    const createdAt = this.timestamp();
    const compaction: ModelCompactionRef = Object.freeze({
      id: requiredToken(result.compactionId, "compactionId"),
      continuationId: current.id,
      providerId: current.providerId,
      model: current.model,
      requestId: requiredToken(result.requestId, "requestId"),
      responseId: requiredToken(result.responseId, "responseId"),
      state: result.state,
      createdAt,
    });
    const compactedContinuation = snapshotModelContinuationRef({
      ...current,
      id: this.createContinuationId({
        branchId,
        requestId: compaction.requestId,
        responseId: compaction.responseId,
      }),
      predecessor: Object.freeze({
        continuationId: current.id,
        responseId: current.responseId,
      }),
      requestId: compaction.requestId,
      responseId: compaction.responseId,
      state: compaction.state,
      createdAt,
    });
    try {
      const committed = await this.store.commit({
        branchId,
        expectedContinuationId: current.id,
        continuation: compactedContinuation,
      });
      if (committed.kind === "conflict") {
        return standaloneOutcome(branchId, compaction.requestId, {
          kind: "failed",
          continuationId: current.id,
          code: "continuation_store_conflict",
          message: "Continuation changed before compaction commit.",
        }, this.events, this.timestamp());
      }
    } catch {
      return standaloneOutcome(branchId, compaction.requestId, {
        kind: "failed",
        continuationId: current.id,
        code: "continuation_store_commit_failed",
        message: "Compacted continuation state could not be committed.",
      }, this.events, this.timestamp());
    }
    return standaloneOutcome(branchId, compaction.requestId, {
      kind: "compacted",
      compaction,
    }, this.events, this.timestamp());
  }

  private async preparation(
    lineage: ModelContinuationRequestLineage,
    continuation: ModelContinuationRef | null,
    outcome: ModelContinuationOutcome,
  ): Promise<ModelContinuationPreparation> {
    const recorded = await this.record(lineage, outcome);
    return Object.freeze({ lineage, continuation, outcome: recorded });
  }

  private async clearCandidate(
    candidate: ModelContinuationRef,
    lineage: ModelContinuationRequestLineage,
  ): Promise<boolean> {
    try {
      return (await this.store.clear({
        branchId: lineage.branchId,
        expectedContinuationId: candidate.id,
      })).kind === "committed";
    } catch {
      return false;
    }
  }

  private async record(
    lineage: ModelContinuationRequestLineage,
    input: ModelContinuationOutcome,
  ): Promise<ModelContinuationOutcome> {
    const outcome = snapshotModelContinuationOutcome(input);
    try {
      await this.events.publish(Object.freeze({
        branchId: lineage.branchId,
        requestId: lineage.requestId,
        kind: outcome.kind,
        reason: safeOutcomeReason(outcome),
        occurredAt: this.timestamp(),
      }));
    } catch {
      // Safe status delivery is non-authoritative.
    }
    return outcome;
  }

  private timestamp(): string {
    const value = this.now();
    if (
      typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value
    ) {
      throw new TypeError("Model continuation clock must return an ISO date-time string.");
    }
    return value;
  }
}

export function checkModelContinuationCompatibility(
  continuation: ModelContinuationRef,
  input: ModelContinuationRequestLineage,
  mechanism: ModelContinuationRef["mechanism"],
): ModelContinuationCompatibility {
  const current = snapshotModelContinuationRef(continuation);
  const lineage = snapshotLineage(input);
  const reason: ModelContinuationIncompatibilityReason | null =
    current.providerId !== lineage.providerId ? "provider_changed"
      : current.model !== lineage.model ? "model_changed"
      : current.mechanism !== mechanism ? "mechanism_changed"
      : current.branchId !== lineage.branchId ? "branch_changed"
      : !sameActiveContext(current.activeContext, lineage.activeContext)
      ? "active_context_changed"
      : !sameRevision(current.protocol, lineage.protocol) ? "protocol_changed"
      : !sameRevision(current.toolExposureContent, lineage.toolExposureContent)
      ? "tool_exposure_content_changed"
      : !sameRevision(current.policy, lineage.policy) ? "policy_changed"
      : null;
  return reason === null
    ? Object.freeze({ kind: "compatible" })
    : Object.freeze({ kind: "incompatible", reason });
}

export function createInMemoryModelContinuationStore(): ModelContinuationStore {
  const records = new Map<string, ModelContinuationRef>();
  const store: ModelContinuationStore = {
    async load(branchId) {
      const value = records.get(requiredToken(branchId, "branchId"));
      return value === undefined ? null : snapshotModelContinuationRef(value);
    },
    async commit(input) {
      const branchId = requiredToken(input.branchId, "branchId");
      const current = records.get(branchId) ?? null;
      if ((current?.id ?? null) !== input.expectedContinuationId) {
        return Object.freeze({ kind: "conflict" as const });
      }
      const continuation = snapshotModelContinuationRef(input.continuation);
      if (continuation.branchId !== branchId) {
        throw new TypeError("Continuation branch does not match its Store key.");
      }
      records.set(branchId, continuation);
      return Object.freeze({ kind: "committed" as const });
    },
    async clear(input) {
      const branchId = requiredToken(input.branchId, "branchId");
      const current = records.get(branchId) ?? null;
      if (current?.id !== input.expectedContinuationId) {
        return Object.freeze({ kind: "conflict" as const });
      }
      records.delete(branchId);
      return Object.freeze({ kind: "committed" as const });
    },
  };
  return Object.freeze(store);
}

function snapshotLineage(
  input: ModelContinuationRequestLineage,
): ModelContinuationRequestLineage {
  const activeContext = Object.freeze({
    id: requiredToken(input.activeContext.id, "activeContext.id"),
    runId: requiredToken(input.activeContext.runId, "activeContext.runId"),
    version: nonNegativeInteger(input.activeContext.version, "activeContext.version"),
  });
  return Object.freeze({
    providerId: requiredToken(input.providerId, "providerId"),
    model: requiredToken(input.model, "model"),
    branchId: requiredToken(input.branchId, "branchId"),
    requestId: requiredToken(input.requestId, "requestId"),
    activeContext,
    protocol: revision(input.protocol, "protocol"),
    toolExposureContent: revision(input.toolExposureContent, "toolExposureContent"),
    policy: revision(input.policy, "policy"),
  });
}

function revision(input: ModelContinuationRevisionRef, path: string) {
  return Object.freeze({
    id: requiredToken(input.id, `${path}.id`),
    revision: requiredToken(input.revision, `${path}.revision`),
  });
}

function sameRevision(
  left: ModelContinuationRevisionRef,
  right: ModelContinuationRevisionRef,
): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameActiveContext(
  left: ModelContinuationActiveContextRef,
  right: ModelContinuationActiveContextRef,
): boolean {
  return left.id === right.id && left.runId === right.runId &&
    left.version === right.version;
}

function safeOutcomeReason(outcome: ModelContinuationOutcome): string | null {
  switch (outcome.kind) {
    case "reset": return outcome.reason;
    case "unavailable": return outcome.reason;
    case "rejected": return outcome.providerCode;
    case "failed": return outcome.code;
    default: return null;
  }
}

function requiredToken(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return value;
}

async function standaloneOutcome(
  branchId: string,
  requestId: string,
  input: ModelContinuationOutcome,
  events: ModelContinuationEventSink,
  occurredAt: string,
): Promise<ModelContinuationOutcome> {
  const outcome = snapshotModelContinuationOutcome(input);
  try {
    await events.publish(Object.freeze({
      branchId,
      requestId,
      kind: outcome.kind,
      reason: safeOutcomeReason(outcome),
      occurredAt,
    }));
  } catch {
    // Safe status delivery is non-authoritative.
  }
  return outcome;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer.`);
  }
  return value as number;
}
