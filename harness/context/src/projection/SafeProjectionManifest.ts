import type {
  ContextProjectionDisposition,
  ProjectionManifest,
} from "./ContextProjection.js";
import { snapshotProjectionManifest } from "./ContextProjection.js";

export interface SafeProjectionManifest {
  readonly schemaVersion: 1;
  readonly manifestId: string;
  readonly projectionId: string;
  readonly requestId: string;
  readonly activeContextId: string;
  readonly activeContextVersion: number;
  readonly profileId: string;
  readonly profileRevision: string;
  readonly policyId: string;
  readonly policyRevision: string;
  readonly estimatorId: string;
  readonly estimatorRevision: string;
  readonly accountingUnit: "bytes" | "tokens";
  readonly budgetMaximum: number;
  readonly consideredItemCount: number;
  readonly projectedItemCount: number;
  readonly projectedAmount: number;
  readonly dispositionCounts: Readonly<Record<ContextProjectionDisposition, number>>;
  readonly outcome: "projected" | "blocked";
  readonly code: string | null;
  readonly createdAt: string;
}

export function createSafeProjectionManifest(input: {
  readonly manifest: ProjectionManifest;
  readonly outcome: SafeProjectionManifest["outcome"];
  readonly code: string | null;
}): SafeProjectionManifest {
  const manifest = snapshotProjectionManifest(input.manifest);
  if (input.outcome !== "projected" && input.outcome !== "blocked") {
    throw new TypeError("Safe Projection Manifest outcome is invalid.");
  }
  if (
    (input.outcome === "projected" && input.code !== null) ||
    (input.outcome === "blocked" &&
      (typeof input.code !== "string" || input.code.trim().length === 0))
  ) {
    throw new TypeError("Safe Projection Manifest code does not match its outcome.");
  }
  const counts: Record<ContextProjectionDisposition, number> = {
    included: 0,
    transformed: 0,
    referenced: 0,
    omitted: 0,
    rejected: 0,
    blocked: 0,
  };
  for (const record of manifest.records) counts[record.disposition] += 1;
  return Object.freeze({
    schemaVersion: 1,
    manifestId: manifest.id,
    projectionId: manifest.projectionId,
    requestId: manifest.requestId,
    activeContextId: manifest.activeContext.id,
    activeContextVersion: manifest.activeContext.version,
    profileId: manifest.profile.id,
    profileRevision: manifest.profile.revision,
    policyId: manifest.policy.id,
    policyRevision: manifest.policy.revision,
    estimatorId: manifest.estimator.id,
    estimatorRevision: manifest.estimator.revision,
    accountingUnit: manifest.accounting.unit,
    budgetMaximum: manifest.budget.maximum,
    consideredItemCount: manifest.accounting.consideredItems,
    projectedItemCount: manifest.accounting.projectedItems,
    projectedAmount: manifest.accounting.projectedAmount,
    dispositionCounts: Object.freeze(counts),
    outcome: input.outcome,
    code: input.code,
    createdAt: manifest.createdAt,
  });
}

export function snapshotSafeProjectionManifest(
  input: SafeProjectionManifest,
): SafeProjectionManifest {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Safe Projection Manifest must be an object.");
  }
  const expectedKeys = [
    "schemaVersion", "manifestId", "projectionId", "requestId",
    "activeContextId", "activeContextVersion", "profileId",
    "profileRevision", "policyId", "policyRevision", "estimatorId",
    "estimatorRevision", "accountingUnit", "budgetMaximum",
    "consideredItemCount", "projectedItemCount", "projectedAmount",
    "dispositionCounts", "outcome", "code", "createdAt",
  ];
  if (
    Object.keys(input).some((key) => !expectedKeys.includes(key)) ||
    input.schemaVersion !== 1 ||
    !isToken(input.manifestId) || !isToken(input.projectionId) ||
    !isToken(input.requestId) || !isToken(input.activeContextId) ||
    !isCount(input.activeContextVersion) || !isToken(input.profileId) ||
    !isToken(input.profileRevision) || !isToken(input.policyId) ||
    !isToken(input.policyRevision) || !isToken(input.estimatorId) ||
    !isToken(input.estimatorRevision) ||
    (input.accountingUnit !== "bytes" && input.accountingUnit !== "tokens") ||
    !isCount(input.budgetMaximum) || !isCount(input.consideredItemCount) ||
    !isCount(input.projectedItemCount) || !isCount(input.projectedAmount) ||
    (input.outcome !== "projected" && input.outcome !== "blocked") ||
    (input.outcome === "projected" ? input.code !== null : !isToken(input.code)) ||
    !isToken(input.createdAt) || !Number.isFinite(Date.parse(input.createdAt))
  ) {
    throw new TypeError("Safe Projection Manifest is invalid.");
  }
  const countKeys: ContextProjectionDisposition[] = [
    "included", "transformed", "referenced", "omitted", "rejected", "blocked",
  ];
  if (
    input.dispositionCounts === null || typeof input.dispositionCounts !== "object" ||
    Array.isArray(input.dispositionCounts) ||
    Object.keys(input.dispositionCounts).length !== countKeys.length ||
    countKeys.some((key) => !isCount(input.dispositionCounts[key])) ||
    countKeys.reduce((total, key) => total + input.dispositionCounts[key], 0) !==
      input.consideredItemCount
  ) {
    throw new TypeError("Safe Projection Manifest disposition counts are invalid.");
  }
  return Object.freeze({
    ...input,
    dispositionCounts: Object.freeze({ ...input.dispositionCounts }),
  });
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
