import type { Metadata } from "@agent-anything/shared";
import { ApprovalContractError } from "./ApprovalContractError.js";

export function cloneApprovalMetadata(metadata: Metadata): Metadata {
  const clone = cloneApprovalValue(metadata, "metadata");
  if (!isPlainRecord(clone)) {
    throw new ApprovalContractError(
      "approval_request_invalid_metadata",
      "Approval metadata must be a plain object.",
    );
  }
  return clone;
}

export function cloneApprovalValue<T>(value: T, path: string): T {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      cloneApprovalValue(item, `${path}[${index}]`),
    ) as T;
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        cloneApprovalValue(item, `${path}.${key}`),
      ]),
    ) as T;
  }
  throw new ApprovalContractError(
    "approval_request_invalid_metadata",
    `Approval ${path} contains a non-snapshot value.`,
  );
}

export function deepFreezeApproval<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeApproval(child);
  return Object.freeze(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
