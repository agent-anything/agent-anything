import type { HostRunProjection } from "@agent-anything/host";
import type {
  HelarcActivityItem,
  HelarcProductPhase,
  HelarcProductResult,
} from "../composition/index.js";

export interface HelarcProductRunProjection {
  readonly runId: string;
  readonly sequence: number;
  readonly phase: HelarcProductPhase;
  readonly activity: readonly HelarcActivityItem[];
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

export type HelarcProductRunProjectionUpdate =
  | HelarcProductPhaseProjectionUpdate
  | HelarcProductActivityProjectionUpdate
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
  readonly statusSource: "platform" | "product";
}

export interface HelarcRunProjection {
  readonly runId: string;
  readonly platform: HostRunProjection;
  readonly product: HelarcProductRunProjection;
  readonly display: HelarcRunDisplayProjection;
}

export type HelarcRunProjectionUpdate =
  | { readonly kind: "platform"; readonly projection: HostRunProjection }
  | { readonly kind: "product"; readonly projection: HelarcProductRunProjection };

export type HelarcRunProjectionRejectionCode =
  | "stale_platform_sequence"
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
  readonly platform: HostRunProjection;
  readonly product: HelarcProductRunProjection;
}): HelarcRunProjection {
  assertProjectionPair(input.platform, input.product);
  return snapshotUnifiedProjection(input.platform, input.product);
}

export function reduceHelarcRunProjection(
  current: HelarcRunProjection,
  update: HelarcRunProjectionUpdate,
): HelarcRunProjectionReduction {
  if (!isUnifiedProjection(current) || update === null || typeof update !== "object") {
    return rejectUnified(current, "invalid_projection");
  }
  try {
    if (update.kind === "platform") {
      if (update.projection.runId !== current.runId) {
        return rejectUnified(current, "run_identity_mismatch");
      }
      if (update.projection.sequence <= current.platform.sequence) {
        return rejectUnified(current, "stale_platform_sequence");
      }
      return appliedUnified(snapshotUnifiedProjection(update.projection, current.product));
    }
    if (update.kind === "product") {
      if (update.projection.runId !== current.runId) {
        return rejectUnified(current, "run_identity_mismatch");
      }
      if (update.projection.sequence <= current.product.sequence) {
        return rejectUnified(current, "stale_product_sequence");
      }
      return appliedUnified(snapshotUnifiedProjection(current.platform, update.projection));
    }
    return rejectUnified(current, "invalid_projection");
  } catch {
    return rejectUnified(current, "invalid_projection");
  }
}

export function deriveHelarcRunDisplayProjection(
  platform: HostRunProjection,
  product: HelarcProductRunProjection,
): HelarcRunDisplayProjection {
  assertProjectionPair(platform, product);

  if (platform.status === "blocked" || platform.status === "failed" ||
    platform.status === "cancelled") {
    return display(platform.status, true, "platform");
  }
  if (platform.status === "completed") {
    const productStatus = product.result?.status ?? null;
    if (productStatus === "rejected" || productStatus === "blocked" || productStatus === "failed") {
      return display(productStatus, true, "product");
    }
    return display("completed", true, "platform");
  }
  if (platform.status === "cancelling") {
    return display("cancelling", false, "platform");
  }
  if (platform.status === "waiting_for_approval" || platform.approval !== null) {
    return display("waiting_for_approval", false, "platform");
  }
  if (product.phase.kind === "waiting_for_patch_review") {
    return display(
      product.phase.review.phase === "submitted_for_resolution"
        ? "applying_patch"
        : "waiting_for_patch_review",
      false,
      "product",
    );
  }
  if (product.phase.kind === "patch_action_submitted") {
    return display("applying_patch", false, "product");
  }
  return display(platform.status === "starting" ? "starting" : "running", false, "platform");
}

function snapshotUnifiedProjection(
  platform: HostRunProjection,
  product: HelarcProductRunProjection,
): HelarcRunProjection {
  assertProjectionPair(platform, product);
  return Object.freeze({
    runId: platform.runId,
    platform,
    product,
    display: deriveHelarcRunDisplayProjection(platform, product),
  });
}

function snapshotProductPhase(phase: HelarcProductPhase): HelarcProductPhase {
  if (phase?.kind === "none") return Object.freeze({ kind: "none" });
  if (phase?.kind === "waiting_for_patch_review") {
    const review = phase.review;
    if (
      !hasIdentity(review?.runId) || !hasIdentity(review.proposalId) ||
      !hasIdentity(review.reviewId) || !Number.isSafeInteger(review.pendingVersion) ||
      review.pendingVersion < 1 ||
      (review.phase !== "reviewing" && review.phase !== "submitted_for_resolution")
    ) {
      throw new TypeError("Patch review phase is invalid.");
    }
    return Object.freeze({ kind: "waiting_for_patch_review", review: Object.freeze({ ...review }) });
  }
  if (phase?.kind === "patch_action_submitted") {
    if (
      !hasIdentity(phase.runId) || !hasIdentity(phase.proposalId) ||
      !hasIdentity(phase.reviewId) || !Number.isSafeInteger(phase.pendingVersion) ||
      phase.pendingVersion < 1
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
    output: Object.freeze({
      ...result.output,
      enforcement: Object.freeze({ ...result.output.enforcement }),
      safeErrors: Object.freeze(result.output.safeErrors.map((error) => Object.freeze({ ...error }))),
    }),
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
    hasIdentity((value as { runId?: unknown }).runId) &&
    isProductProjection((value as { product?: unknown }).product) &&
    (value as { platform?: unknown }).platform !== null &&
    typeof (value as { platform?: unknown }).platform === "object";
}

function assertProjectionPair(
  platform: HostRunProjection,
  product: HelarcProductRunProjection,
): void {
  if (
    platform === null || typeof platform !== "object" || !hasIdentity(platform.runId) ||
    !Number.isSafeInteger(platform.sequence) || platform.sequence < 0 ||
    !isProductProjection(product) || platform.runId !== product.runId
  ) {
    throw new TypeError("Host and product projections must identify the same Run.");
  }
}

function display(
  status: HelarcRunDisplayStatus,
  terminal: boolean,
  statusSource: "platform" | "product",
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
