import type { HostRunProjection } from "@agent-anything/host/projection";
import {
  HELARC_PATCH_REVIEW_PROTOCOL,
  type HelarcProductPhase,
} from "../composition/HelarcPatchReview.js";
import type {
  HelarcActivityItem,
  HelarcProductResult,
} from "../composition/HelarcProductResult.js";
import type { ModelContinuationSafeEvent } from "@agent-anything/model-interaction/continuation";

export type HelarcModelContinuationProjection = ModelContinuationSafeEvent;

export interface HelarcProductRunProjection {
  readonly runId: string;
  readonly sequence: number;
  readonly phase: HelarcProductPhase;
  readonly activity: readonly HelarcActivityItem[];
  readonly continuation: HelarcModelContinuationProjection | null;
  readonly result: HelarcProductResult | null;
}

export type HelarcProductRunProjectionListener = (
  projection: HelarcProductRunProjection,
) => void;

interface HelarcProductProjectionUpdateBase<TKind extends string> {
  readonly kind: TKind;
  readonly runId: string;
  readonly sequence: number;
}

export interface HelarcProductPhaseProjectionUpdate
  extends HelarcProductProjectionUpdateBase<"phase_changed"> {
  readonly phase: HelarcProductPhase;
}

export interface HelarcProductActivityProjectionUpdate
  extends HelarcProductProjectionUpdateBase<"activity_appended"> {
  readonly activity: HelarcActivityItem;
}

export interface HelarcProductResultProjectionUpdate
  extends HelarcProductProjectionUpdateBase<"result_settled"> {
  readonly result: HelarcProductResult;
}

export interface HelarcModelContinuationProjectionUpdate
  extends HelarcProductProjectionUpdateBase<"continuation_changed"> {
  readonly continuation: HelarcModelContinuationProjection;
}

export type HelarcProductRunProjectionUpdate =
  | HelarcProductPhaseProjectionUpdate
  | HelarcProductActivityProjectionUpdate
  | HelarcModelContinuationProjectionUpdate
  | HelarcProductResultProjectionUpdate;

export type HelarcProductRunProjectionRejectionCode =
  | "stale_sequence"
  | "run_identity_mismatch"
  | "invalid_transition"
  | "invalid_update";

export type HelarcProductRunProjectionReduction =
  | { readonly status: "applied"; readonly projection: HelarcProductRunProjection }
  | {
      readonly status: "rejected";
      readonly code: HelarcProductRunProjectionRejectionCode;
      readonly projection: HelarcProductRunProjection;
    };

export type HelarcRunDisplayStatus =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_patch_review"
  | "applying_patch"
  | "cancelling"
  | "completed"
  | "rejected"
  | "blocked"
  | "failed"
  | "cancelled";

export interface HelarcRunDisplayProjection {
  readonly status: HelarcRunDisplayStatus;
  readonly terminal: boolean;
  readonly statusSource: "host" | "product";
}

export interface HelarcRunProjection {
  readonly productRunId: string;
  readonly harnessRunId: string;
  readonly host: HostRunProjection;
  readonly product: HelarcProductRunProjection;
  readonly display: HelarcRunDisplayProjection;
}

export type HelarcRunProjectionUpdate =
  | { readonly kind: "host"; readonly projection: HostRunProjection }
  | { readonly kind: "product"; readonly projection: HelarcProductRunProjection };

export type HelarcRunProjectionRejectionCode =
  | "stale_host_sequence"
  | "stale_product_sequence"
  | "run_identity_mismatch"
  | "invalid_projection";

export type HelarcRunProjectionReduction =
  | { readonly status: "applied"; readonly projection: HelarcRunProjection }
  | {
      readonly status: "rejected";
      readonly code: HelarcRunProjectionRejectionCode;
      readonly projection: HelarcRunProjection;
    };

export function createHelarcProductRunProjection(runId: string): HelarcProductRunProjection {
  assertIdentity(runId, "runId");
  return Object.freeze({
    runId,
    sequence: 0,
    phase: Object.freeze({ kind: "none" as const }),
    activity: Object.freeze([]),
    continuation: null,
    result: null,
  });
}

export function reduceHelarcProductRunProjection(
  current: HelarcProductRunProjection,
  update: HelarcProductRunProjectionUpdate,
): HelarcProductRunProjectionReduction {
  if (!isProductProjection(current) || !isProjectionUpdateBase(update)) {
    return rejectProduct(current, "invalid_update");
  }
  if (update.runId !== current.runId) {
    return rejectProduct(current, "run_identity_mismatch");
  }
  if (update.sequence <= current.sequence) {
    return rejectProduct(current, "stale_sequence");
  }
  if (current.result !== null) {
    return rejectProduct(current, "invalid_transition");
  }

  try {
    switch (update.kind) {
      case "phase_changed":
        return appliedProduct(Object.freeze({
          ...current,
          sequence: update.sequence,
          phase: snapshotProductPhase(update.phase),
        }));
      case "activity_appended": {
        const activity = snapshotActivity(update.activity);
        const previous = current.activity.at(-1);
        if (
          previous !== undefined &&
          (activity.sequence <= previous.sequence ||
            current.activity.some((candidate) => candidate.id === activity.id))
        ) {
          return rejectProduct(current, "invalid_update");
        }
        return appliedProduct(Object.freeze({
          ...current,
          sequence: update.sequence,
          activity: Object.freeze([...current.activity, activity]),
        }));
      }
      case "continuation_changed":
        return appliedProduct(Object.freeze({
          ...current,
          sequence: update.sequence,
          continuation: snapshotContinuationProjection(update.continuation),
        }));
      case "result_settled":
        return appliedProduct(Object.freeze({
          ...current,
          sequence: update.sequence,
          phase: Object.freeze({ kind: "none" as const }),
          result: snapshotProductResult(update.result),
        }));
      default:
        return rejectProduct(current, "invalid_update");
    }
  } catch {
    return rejectProduct(current, "invalid_update");
  }
}

export function createHelarcRunProjection(input: {
  readonly host: HostRunProjection;
  readonly product: HelarcProductRunProjection;
}): HelarcRunProjection {
  assertProjectionPair(input.host, input.product);
  return snapshotUnifiedProjection(input.host, input.product);
}

export function reduceHelarcRunProjection(
  current: HelarcRunProjection,
  update: HelarcRunProjectionUpdate,
): HelarcRunProjectionReduction {
  if (!isUnifiedProjection(current) || update === null || typeof update !== "object") {
    return rejectUnified(current, "invalid_projection");
  }
  try {
    if (update.kind === "host") {
      if (update.projection.runId !== current.harnessRunId) {
        return rejectUnified(current, "run_identity_mismatch");
      }
      if (update.projection.sequence <= current.host.sequence) {
        return rejectUnified(current, "stale_host_sequence");
      }
      return appliedUnified(snapshotUnifiedProjection(update.projection, current.product));
    }
    if (update.kind === "product") {
      if (update.projection.runId !== current.productRunId) {
        return rejectUnified(current, "run_identity_mismatch");
      }
      if (update.projection.sequence <= current.product.sequence) {
        return rejectUnified(current, "stale_product_sequence");
      }
      return appliedUnified(snapshotUnifiedProjection(current.host, update.projection));
    }
    return rejectUnified(current, "invalid_projection");
  } catch {
    return rejectUnified(current, "invalid_projection");
  }
}

export function deriveHelarcRunDisplayProjection(
  host: HostRunProjection,
  product: HelarcProductRunProjection,
): HelarcRunDisplayProjection {
  assertProjectionPair(host, product);

  if (host.status === "blocked" || host.status === "failed" ||
    host.status === "cancelled") {
    return display(host.status, true, "host");
  }
  if (host.status === "completed") {
    const productStatus = product.result?.status ?? null;
    if (productStatus === "rejected" || productStatus === "blocked" || productStatus === "failed") {
      return display(productStatus, true, "product");
    }
    return display("completed", true, "host");
  }
  if (host.status === "cancelling") {
    return display("cancelling", false, "host");
  }
  if (host.pendingInteractions.some((pending) =>
    pending.request.protocol.owner === "permission" &&
    pending.request.protocol.kind === "approval"
  )) {
    return display("waiting_for_approval", false, "host");
  }
  const pendingPatchReview = host.pendingInteractions.find((pending) =>
    pending.request.protocol.owner === HELARC_PATCH_REVIEW_PROTOCOL.owner &&
    pending.request.protocol.kind === HELARC_PATCH_REVIEW_PROTOCOL.kind &&
    pending.request.protocol.revision === HELARC_PATCH_REVIEW_PROTOCOL.revision
  );
  if (pendingPatchReview !== undefined) {
    return display(
      pendingPatchReview.phase === "submitted_for_resolution"
        ? "applying_patch"
        : "waiting_for_patch_review",
      false,
      "host",
    );
  }
  if (product.phase.kind === "patch_action_submitted") {
    return display("applying_patch", false, "product");
  }
  return display(host.status === "starting" ? "starting" : "running", false, "host");
}

function snapshotUnifiedProjection(
  host: HostRunProjection,
  product: HelarcProductRunProjection,
): HelarcRunProjection {
  assertProjectionPair(host, product);
  return Object.freeze({
    productRunId: product.runId,
    harnessRunId: host.runId,
    host,
    product,
    display: deriveHelarcRunDisplayProjection(host, product),
  });
}

function snapshotProductPhase(phase: HelarcProductPhase): HelarcProductPhase {
  if (phase?.kind === "none") return Object.freeze({ kind: "none" });
  if (phase?.kind === "patch_review_requested") {
    if (
      !hasIdentity(phase.proposalId) ||
      !Number.isSafeInteger(phase.proposalRevision) || phase.proposalRevision < 1 ||
      !hasIdentity(phase.reviewId)
    ) {
      throw new TypeError("Patch review phase is invalid.");
    }
    return Object.freeze({ ...phase });
  }
  if (phase?.kind === "patch_action_submitted") {
    if (
      !hasIdentity(phase.proposalId) ||
      !Number.isSafeInteger(phase.proposalRevision) || phase.proposalRevision < 1 ||
      !hasIdentity(phase.reviewId) || !Number.isSafeInteger(phase.requestVersion) ||
      phase.requestVersion < 1
    ) {
      throw new TypeError("Submitted Patch Action phase is invalid.");
    }
    return Object.freeze({ ...phase });
  }
  throw new TypeError("Product phase is invalid.");
}

function snapshotActivity(activity: HelarcActivityItem): HelarcActivityItem {
  if (
    !hasIdentity(activity?.id) || !Number.isSafeInteger(activity.sequence) ||
    activity.sequence < 1 || !hasIdentity(activity.timestamp) ||
    !Number.isFinite(Date.parse(activity.timestamp)) || !hasIdentity(activity.kind) ||
    !hasIdentity(activity.title) ||
    (activity.detail !== null && typeof activity.detail !== "string") ||
    activity.metadata === null || typeof activity.metadata !== "object" ||
    Array.isArray(activity.metadata)
  ) {
    throw new TypeError("Product activity is invalid.");
  }
  return Object.freeze({ ...activity, metadata: Object.freeze({ ...activity.metadata }) });
}

function snapshotContinuationProjection(
  value: HelarcModelContinuationProjection,
): HelarcModelContinuationProjection {
  const allowedKinds = new Set([
    "reused", "advanced", "reset", "unavailable", "rejected", "cancelled",
    "failed", "compacted",
  ]);
  if (
    value === null || typeof value !== "object" ||
    !hasIdentity(value.branchId) || !hasIdentity(value.requestId) ||
    !allowedKinds.has(value.kind) ||
    (value.reason !== null && typeof value.reason !== "string") ||
    !hasIdentity(value.occurredAt) || !Number.isFinite(Date.parse(value.occurredAt))
  ) {
    throw new TypeError("Model continuation projection is invalid.");
  }
  return Object.freeze({ ...value });
}

function snapshotProductResult(result: HelarcProductResult): HelarcProductResult {
  if (
    result === null || typeof result !== "object" ||
    (result.status !== "completed" && result.status !== "rejected" &&
      result.status !== "failed" && result.status !== "blocked" && result.status !== "cancelled") ||
    result.output === null || typeof result.output !== "object"
  ) {
    throw new TypeError("Product result is invalid.");
  }
  return Object.freeze({
    status: result.status,
    runResult: Object.freeze({ ...result.runResult }),
    output: Object.freeze({
      ...result.output,
      workspace: Object.freeze({
        primaryId: result.output.workspace.primaryId,
        additionalIds: Object.freeze([...result.output.workspace.additionalIds]),
      }),
      enforcement: Object.freeze({ ...result.output.enforcement }),
      safeErrors: Object.freeze(result.output.safeErrors.map((error) => Object.freeze({ ...error }))),
    }),
    runActions: Object.freeze(result.runActions.map((action) => Object.freeze({ ...action }))),
    effects: Object.freeze(result.effects.map((effect) => Object.freeze({
      ...effect,
      lowerRefs: Object.freeze(effect.lowerRefs.map((reference) => Object.freeze({ ...reference }))),
    }))),
    actions: Object.freeze(result.actions.map((action) => Object.freeze({ ...action }))),
    composites: Object.freeze(result.composites.map((composite) => Object.freeze({
      ...composite,
      childOperationResultIds: Object.freeze([...composite.childOperationResultIds]),
    }))),
    children: Object.freeze(result.children.map((child) => Object.freeze({ ...child }))),
    interactions: Object.freeze(result.interactions.map((interaction) =>
      Object.freeze({ ...interaction })
    )),
    validation: Object.freeze({
      status: result.validation.status,
      snapshotRevision: result.validation.snapshotRevision,
      counts: Object.freeze(result.validation.counts.map((entry) => Object.freeze({ ...entry }))),
      activeChecks: result.validation.activeChecks,
      gateStatus: result.validation.gateStatus,
      safeReasons: Object.freeze([...result.validation.safeReasons]),
      updatedAt: result.validation.updatedAt,
    }),
    uncertainty: Object.freeze([...result.uncertainty]),
    residualRisk: Object.freeze([...result.residualRisk]),
    incompleteWork: Object.freeze([...result.incompleteWork]),
    nextActions: Object.freeze([...result.nextActions]),
    artifactRefs: Object.freeze([...result.artifactRefs]),
  });
}

function isProjectionUpdateBase(value: unknown): value is HelarcProductRunProjectionUpdate {
  return value !== null && typeof value === "object" &&
    hasIdentity((value as { runId?: unknown }).runId) &&
    Number.isSafeInteger((value as { sequence?: unknown }).sequence) &&
    ((value as { sequence: number }).sequence > 0);
}

function isProductProjection(value: unknown): value is HelarcProductRunProjection {
  return value !== null && typeof value === "object" &&
    hasIdentity((value as { runId?: unknown }).runId) &&
    Number.isSafeInteger((value as { sequence?: unknown }).sequence) &&
    (value as { sequence: number }).sequence >= 0;
}

function isUnifiedProjection(value: unknown): value is HelarcRunProjection {
  return value !== null && typeof value === "object" &&
    hasIdentity((value as { productRunId?: unknown }).productRunId) &&
    hasIdentity((value as { harnessRunId?: unknown }).harnessRunId) &&
    isProductProjection((value as { product?: unknown }).product) &&
    (value as { product: HelarcProductRunProjection }).product.runId ===
      (value as { productRunId: string }).productRunId &&
    (value as { host?: unknown }).host !== null &&
    typeof (value as { host?: unknown }).host === "object" &&
    (value as { host: HostRunProjection }).host.runId ===
      (value as { harnessRunId: string }).harnessRunId;
}

function assertProjectionPair(
  host: HostRunProjection,
  product: HelarcProductRunProjection,
): void {
  if (
    host === null || typeof host !== "object" || !hasIdentity(host.runId) ||
    !Number.isSafeInteger(host.sequence) || host.sequence < 0 ||
    !isProductProjection(product)
  ) {
    throw new TypeError("Host and product projections must carry valid Run identities.");
  }
}

function display(
  status: HelarcRunDisplayStatus,
  terminal: boolean,
  statusSource: "host" | "product",
): HelarcRunDisplayProjection {
  return Object.freeze({ status, terminal, statusSource });
}

function appliedProduct(
  projection: HelarcProductRunProjection,
): HelarcProductRunProjectionReduction {
  return Object.freeze({ status: "applied", projection });
}

function rejectProduct(
  projection: HelarcProductRunProjection,
  code: HelarcProductRunProjectionRejectionCode,
): HelarcProductRunProjectionReduction {
  return Object.freeze({ status: "rejected", code, projection });
}

function appliedUnified(projection: HelarcRunProjection): HelarcRunProjectionReduction {
  return Object.freeze({ status: "applied", projection });
}

function rejectUnified(
  projection: HelarcRunProjection,
  code: HelarcRunProjectionRejectionCode,
): HelarcRunProjectionReduction {
  return Object.freeze({ status: "rejected", code, projection });
}

function assertIdentity(value: unknown, field: string): asserts value is string {
  if (!hasIdentity(value)) throw new TypeError(`${field} must be a non-empty string.`);
}

function hasIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
