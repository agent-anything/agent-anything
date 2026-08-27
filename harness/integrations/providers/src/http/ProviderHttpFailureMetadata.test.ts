import { describe, expect, it } from "vitest";
import {
  classifyProviderHttpFailure,
  readProviderHttpFailureMetadata,
} from "./ProviderHttpFailureMetadata.js";

describe("classifyProviderHttpFailure", () => {
  it("keeps authentication, timeout, rate limit, availability, and other HTTP failures distinct", () => {
    expect(classifyProviderHttpFailure(401)).toMatchObject({
      category: "authentication",
      code: "provider_authentication_failed",
    });
    expect(classifyProviderHttpFailure(408)).toMatchObject({
      category: "timeout",
      code: "provider_timeout",
    });
    expect(classifyProviderHttpFailure(429)).toMatchObject({
      category: "rate_limit",
      code: "provider_rate_limited",
    });
    expect(classifyProviderHttpFailure(503)).toMatchObject({
      category: "server_error",
      code: "provider_remote_unavailable",
    });
    expect(classifyProviderHttpFailure(500)).toMatchObject({
      category: "server_error",
      code: "provider_server_error",
    });
    expect(classifyProviderHttpFailure(400)).toMatchObject({
      category: "http",
      code: "provider_http_error",
    });
  });
});

describe("readProviderHttpFailureMetadata", () => {
  it("normalizes delta-seconds and an allowlisted request id", () => {
    const headers = new Map([
      ["retry-after", "2"],
      ["x-request-id", "request_123"],
      ["authorization", "secret"],
    ]);

    expect(readProviderHttpFailureMetadata({
      status: 429,
      headers: { get: (name) => headers.get(name) ?? null },
    })).toEqual({
      statusCode: 429,
      retryAfterMs: 2_000,
      requestId: "request_123",
    });
  });

  it("normalizes an HTTP-date against the supplied clock", () => {
    expect(readProviderHttpFailureMetadata({
      status: 503,
      headers: { get: (name) => name === "retry-after"
        ? "Tue, 14 Jul 2026 00:00:02 GMT"
        : null },
    }, Date.parse("2026-07-14T00:00:00.500Z"))).toEqual({
      statusCode: 503,
      retryAfterMs: 1_500,
    });
  });

  it("omits malformed or fractional delay and unbounded request identifiers", () => {
    expect(readProviderHttpFailureMetadata({
      status: 500,
      headers: { get: (name) => name === "retry-after" ? "1.25" : "x".repeat(257) },
    })).toEqual({ statusCode: 500 });
  });
});
