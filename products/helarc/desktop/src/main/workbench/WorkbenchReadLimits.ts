import type {
  WorkbenchRejected,
  WorkbenchScope,
  WorkScope,
} from "../../shared/HelarcWorkbench.js";

export const PAGE_BYTES = 256 * 1024;
export function readToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}
export function workScopeValid(value: unknown): value is WorkScope {
  const q = value as Partial<WorkScope> | null;
  return !!q && readToken(q.threadId) && readToken(q.productRunId);
}
export function taskScopeValid(value: unknown): value is WorkbenchScope {
  return workScopeValid(value) && readToken((value as WorkbenchScope).runId);
}
export function readRejected(
  code: WorkbenchRejected["code"],
): WorkbenchRejected {
  return { status: "rejected", code };
}
export function encodePosition(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function decodePosition(value: string): Record<string, unknown> | null {
  if (!readToken(value)) return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    return decoded !== null &&
      typeof decoded === "object" &&
      !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
export function fitsPage(value: unknown, maximum = PAGE_BYTES): boolean {
  return Buffer.byteLength(JSON.stringify(value)) <= maximum;
}
export function textPage(
  text: string,
  offset = 0,
  maximum = 8192,
  encodedBudget = Number.POSITIVE_INFINITY,
): { text: string; end: number; omittedBytes: number } {
  let end = Math.min(text.length, offset + maximum);
  if (
    Buffer.byteLength(JSON.stringify(text.slice(offset, end))) > encodedBudget
  ) {
    let low = offset,
      high = end;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (
        Buffer.byteLength(JSON.stringify(text.slice(offset, middle))) <=
        encodedBudget
      )
        low = middle;
      else high = middle - 1;
    }
    end = low;
  }
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
  return {
    text: text.slice(offset, end),
    end,
    omittedBytes: Buffer.byteLength(text.slice(end)),
  };
}
export function validOffset(text: string, value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= text.length &&
    !(
      (value as number) > 0 &&
      /[\uDC00-\uDFFF]/u.test(text[value as number] ?? "")
    )
  );
}
