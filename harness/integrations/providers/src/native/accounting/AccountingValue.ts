import { snapshotModelJsonValue } from "@agent-anything/model-interaction";
import { digest } from "../NativeJson.js";

export function snapshot<T>(value: T): T {
  return snapshotModelJsonValue(value, "native accounting") as T;
}
export function key(value: unknown): string { return digest(value); }
export function requireText(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) throw new TypeError("accounting_identity_invalid");
}
export function requireTime(value: unknown): asserts value is string {
  requireText(value);
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new TypeError("accounting_time_invalid");
}
export function requireSequence(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("accounting_sequence_invalid");
}
export function equal(left: unknown, right: unknown): boolean { return key(left) === key(right); }
export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
