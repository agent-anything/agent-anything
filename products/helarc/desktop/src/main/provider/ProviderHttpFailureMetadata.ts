export interface HttpResponseHeadersLike {
  get(name: string): string | null;
}

export interface ProviderHttpFailureMetadata {
  readonly statusCode: number;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
}

export function readProviderHttpFailureMetadata(
  response: {
    readonly status: number;
    readonly headers?: HttpResponseHeadersLike;
  },
  nowMs = Date.now(),
): ProviderHttpFailureMetadata {
  const retryAfterMs = readRetryAfterMs(response.headers?.get("retry-after"), nowMs);
  const requestId = readRequestId(
    response.headers?.get("x-request-id") ??
      response.headers?.get("request-id"),
  );

  return {
    statusCode: response.status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

function readRetryAfterMs(value: string | null | undefined, nowMs: number): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  if (/^(?:0|[1-9]\d*)$/.test(normalized)) {
    const milliseconds = Number(normalized) * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  if (/^[+-]?(?:\d|\.\d)/.test(normalized)) {
    return undefined;
  }

  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp) || !Number.isFinite(nowMs)) {
    return undefined;
  }
  const milliseconds = Math.max(0, Math.ceil(timestamp - nowMs));
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function readRequestId(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256
    ? normalized
    : undefined;
}
