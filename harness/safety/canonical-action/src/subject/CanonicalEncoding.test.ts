import { describe, expect, it, vi } from "vitest";
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

  it("preserves the C1 byte format and number normalization", () => {
    const record = Object.assign(Object.create(null), {
      z: [null, true, false, -0, 1.25, 1e30, ""],
      a: "value",
    });
    expect(canonicalEncode("test.domain.v1", record)).toEqual(new TextEncoder().encode(
      "C1S14:test.domain.v1O2{S1:aS5:valueS1:zA7[ZTFN0;N1.25;N1e+30;S0:]}",
    ));
  });

  it("preserves UTF-8 byte prefixes and replacement across block boundaries", () => {
    const strings = [
      "",
      "\0\u007f\u0080\u07ff\u0800\uffff",
      "\ud83d\ude00\ud800x\udc00\ud800\ud800\udc00",
      ...[1000, 1010, 1023, 2045, 4095, 65535, 65536, 131071].map(
        (length) => `${"a".repeat(length)}\ud83d\ude00\u4f60\ud800`,
      ),
      Array.from({ length: 65536 }, (_, code) => String.fromCharCode(code)).join(""),
      "\ud83d\ude00\u4f60\ud800x".repeat(20000),
    ];
    const encoder = new TextEncoder();
    const expected = encoder.encode(
      `C1S14:test.domain.v1A${strings.length}[` +
      strings.map((value) => `S${encoder.encode(value).byteLength}:${value}`).join("") + "]",
    );
    expect(canonicalEncode("test.domain.v1", strings)).toEqual(expected);
  });

  it("shares bounded backing buffers instead of allocating one per encoded fragment", () => {
    const buffers = new Set<ArrayBufferLike>();
    const nativeEncodeInto = TextEncoder.prototype.encodeInto;
    const allocatingEncode = vi.spyOn(TextEncoder.prototype, "encode");
    const encodeInto = vi.spyOn(TextEncoder.prototype, "encodeInto").mockImplementation(
      function (this: TextEncoder, value, target) {
        buffers.add(target.buffer);
        return nativeEncodeInto.call(this, value, target);
      },
    );
    try {
      const output = canonicalEncode("test.domain.v1", Array.from({ length: 10000 }, (_, index) => ({
        key: `value-${index}`,
        flag: index % 2 === 0,
      })));
      expect(output.byteLength).toBeGreaterThan(100000);
      expect(allocatingEncode).not.toHaveBeenCalled();
      expect(encodeInto.mock.calls.length).toBeGreaterThan(10000);
      expect(buffers.size).toBeLessThan(32);
      expect([...buffers].every((buffer) => buffer.byteLength <= 64 * 1024)).toBe(true);
    } finally {
      allocatingEncode.mockRestore();
      encodeInto.mockRestore();
    }
  });

  it("returns exactly sized bytes independent of other encoding calls", () => {
    const first = canonicalEncode("test.domain.v1", ["first", "a".repeat(70000)]);
    const snapshot = first.slice();
    const second = canonicalEncode("test.domain.v1", "b".repeat(200000));
    second.fill(0);
    expect(first).toEqual(snapshot);
    expect(first.byteOffset).toBe(0);
    expect(first.buffer.byteLength).toBe(first.byteLength);
  });

  it("keeps domain, depth, and node-limit errors and paths", () => {
    expect(() => canonicalEncode(" invalid ", null)).toThrowError(expect.objectContaining({
      code: "canonical_encoding_invalid_domain", path: "domain",
    }));
    let nested: unknown = null;
    for (let depth = 0; depth < 64; depth += 1) nested = [nested];
    expect(() => canonicalEncode("test.domain.v1", nested)).not.toThrow();
    expect(() => canonicalEncode("test.domain.v1", [nested])).toThrowError(expect.objectContaining({
      code: "canonical_encoding_too_deep", path: `$${"[0]".repeat(65)}`,
    }));
    expect(() => canonicalEncode("test.domain.v1", Array(99999).fill(null))).not.toThrow();
    expect(() => canonicalEncode("test.domain.v1", Array(100000).fill(null)))
      .toThrowError(expect.objectContaining({
        code: "canonical_encoding_too_large", path: "$[99999]",
      }));
  });

  it("does not invoke rejected accessors, including after allocating several blocks", () => {
    const getter = vi.fn(() => "not data");
    const value = { a: "a".repeat(200000) };
    Object.defineProperty(value, "z", { enumerable: true, get: getter });
    expect(() => canonicalEncode("test.domain.v1", value)).toThrowError(expect.objectContaining({
      code: "canonical_encoding_unsupported_value", path: "$.z",
    }));
    expect(getter).not.toHaveBeenCalled();
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
