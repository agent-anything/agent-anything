import { describe, expect, it } from "vitest";
import { readProviderHttpFailureMetadata } from "./ProviderHttpFailureMetadata.js";

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
