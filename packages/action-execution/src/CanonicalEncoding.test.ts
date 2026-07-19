import { describe, expect, it } from "vitest";
import {
  CanonicalEncodingError,
  canonicalEncode,
  createCanonicalSha256Digest,
} from "./CanonicalEncoding.js";

describe("canonical encoding", () => {
  it("matches a fixed SHA-256 protocol vector", async () => {
    expect(await createCanonicalSha256Digest("test.domain.v1", null)).toBe(
      "sha256:a8daf40368908daf78f948fc1a5f4518ed25c0953579fb6b666bfb81c1b8f579",
    );
  });

  it("is deterministic across object insertion order", async () => {
    const left = { beta: [true, null, "value"], alpha: 42 };
    const right = { alpha: 42, beta: [true, null, "value"] };

    expect([...canonicalEncode("test.domain.v1", left)])
      .toEqual([...canonicalEncode("test.domain.v1", right)]);
    expect(await createCanonicalSha256Digest("test.domain.v1", left))
      .toBe(await createCanonicalSha256Digest("test.domain.v1", right));
  });

  it("preserves value types, array order, string bytes, and domain separation", async () => {
    const values = await Promise.all([
      createCanonicalSha256Digest("test.domain.v1", "1"),
      createCanonicalSha256Digest("test.domain.v1", 1),
      createCanonicalSha256Digest("test.domain.v1", ["a", "b"]),
      createCanonicalSha256Digest("test.domain.v1", ["b", "a"]),
      createCanonicalSha256Digest("test.domain.v1", "你好"),
      createCanonicalSha256Digest("test.other.v1", "你好"),
    ]);

    expect(new Set(values).size).toBe(values.length);
    expect(values.every((value) => /^sha256:[0-9a-f]{64}$/.test(value))).toBe(true);
  });

  it.each([
    ["undefined", { value: undefined }],
    ["function", { value: () => undefined }],
    ["symbol", { value: Symbol("value") }],
    ["non-finite number", { value: Number.POSITIVE_INFINITY }],
    ["custom prototype", Object.create({ inherited: true })],
  ])("rejects %s values", (_label, value) => {
    expect(() => canonicalEncode("test.domain.v1", value)).toThrow(CanonicalEncodingError);
  });

  it("rejects cycles, accessors, sparse arrays, symbols, and forbidden keys", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => "value",
    });
    const sparse = new Array(2);
    sparse[1] = "value";
    const symbolProperty = { value: true } as Record<PropertyKey, unknown>;
    symbolProperty[Symbol("hidden")] = true;
    const forbidden = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(forbidden, "__proto__", {
      value: "value",
      enumerable: true,
    });

    for (const value of [cyclic, accessor, sparse, symbolProperty, forbidden]) {
      expect(() => canonicalEncode("test.domain.v1", value)).toThrow(CanonicalEncodingError);
    }
  });
});
