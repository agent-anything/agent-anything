export interface ExecutionErrorDetails {
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
  readonly fields: Readonly<Record<string, string | number>>;
  readonly cause: ExecutionErrorDetails | null;
}

const fields = ["code", "commitId", "recordId", "runId", "path", "dest", "errno", "syscall", "stage"] as const;

export function diagnosticText(value: string, limit = 4096): string {
  const redacted = value
    .replace(/\b(Bearer|Basic)\s+[^\s,"']+/gi, "$1 [redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|authorization)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
  return redacted.length <= limit ? redacted : `${redacted.slice(0, limit)} [truncated]`;
}

function property(value: object, key: string): unknown {
  try { return Reflect.get(value, key); } catch { return undefined; }
}

/** Only explicit error fields cross the diagnostic channel; never request payloads. */
export function captureExecutionError(error: unknown, seen = new Set<object>(), depth = 0): ExecutionErrorDetails {
  if (depth >= 8 || typeof error === "object" && error !== null && seen.has(error)) {
    return {name: "TruncatedCause", message: "Cause chain depth limit or cycle.", stack: null, fields: {}, cause: null};
  }
  if (typeof error !== "object" || error === null) {
    return {name: "NonErrorThrown", message: typeof error === "string" ? diagnosticText(error) : `Thrown value type: ${typeof error}`,
      stack: null, fields: {}, cause: null};
  }
  seen.add(error);
  const name = property(error, "name"), message = property(error, "message"), stack = property(error, "stack"), cause = property(error, "cause");
  const details: Record<string, string | number> = {};
  for (const key of fields) {
    const value = property(error, key);
    if (typeof value === "string") details[key] = diagnosticText(value, 512);
    else if (typeof value === "number" && Number.isFinite(value)) details[key] = value;
  }
  return {name: typeof name === "string" ? diagnosticText(name, 256) : "Error",
    message: typeof message === "string" ? diagnosticText(message, 2048) : "No error message available.",
    stack: typeof stack === "string" ? diagnosticText(stack, 4096) : null, fields: details,
    cause: cause === undefined || cause === null ? null : captureExecutionError(cause, seen, depth + 1)};
}

export function restoreExecutionError(details: ExecutionErrorDetails): Error {
  const error = new Error(details.message, details.cause ? {cause: restoreExecutionError(details.cause)} : undefined);
  error.name = details.name;
  if (details.stack !== null) error.stack = details.stack;
  for (const key of fields) if (Object.hasOwn(details.fields, key)) Object.defineProperty(error, key, {value: details.fields[key], enumerable: true});
  return error;
}
