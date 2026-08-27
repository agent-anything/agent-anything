import type { HttpResponseHeadersLike } from "./ProviderHttpTransport.js";

export interface ProviderHttpFailureMetadata {
  readonly statusCode: number;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
}

export interface ProviderHttpFailureClassification {
  readonly category: string;
  readonly code: string;
  readonly message: string;
}

export function classifyProviderHttpFailure(
  statusCode: number,
): ProviderHttpFailureClassification {
  if (statusCode === 401 || statusCode === 403) {
    return Object.freeze({
      category: "authentication",
      code: "provider_authentication_failed",
      message: `Provider authentication failed with HTTP ${statusCode}.`,
    });
  }
  if (statusCode === 408) {
    return Object.freeze({
      category: "timeout",
      code: "provider_timeout",
      message: "Provider request timed out with HTTP 408.",
    });
  }
  if (statusCode === 429) {
    return Object.freeze({
      category: "rate_limit",
      code: "provider_rate_limited",
      message: "Provider request was rate limited with HTTP 429.",
    });
  }
  if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return Object.freeze({
      category: "server_error",
      code: "provider_remote_unavailable",
      message: `Provider was unavailable with HTTP ${statusCode}.`,
    });
  }
  if (statusCode >= 500 && statusCode <= 599) {
    return Object.freeze({
      category: "server_error",
      code: "provider_server_error",
      message: `Provider request failed with HTTP ${statusCode}.`,
    });
  }
  return Object.freeze({
    category: "http",
    code: "provider_http_error",
    message: `Provider request failed with HTTP ${statusCode}.`,
  });
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
