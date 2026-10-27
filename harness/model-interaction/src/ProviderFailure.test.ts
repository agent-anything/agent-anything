import {describe, expect, it} from "vitest";
import {snapshotProviderFailure} from "./ProviderResponse.js";

const failure = () => ({category: "http", code: "provider_http_error", message: "Rejected", metadata: {detail: ["measured", 5]}});
describe("Provider failure snapshots", () => {
  it("omits absent optionals and retains an immutable independent JSON snapshot", () => {
    const original = {...failure(), retryAfterMs: undefined, requestId: undefined, statusCode: 400};
    const result = snapshotProviderFailure(original);
    expect(Object.hasOwn(result, "retryAfterMs")).toBe(false);
    expect(Object.hasOwn(result, "requestId")).toBe(false);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    original.metadata.detail.push("changed");
    expect(result.metadata.detail).toEqual(["measured", 5]);
    expect(Object.isFrozen(result.metadata.detail)).toBe(true);
  });
  it("retains provided optional fields including a zero retry delay", () => {
    expect(snapshotProviderFailure({...failure(), statusCode: 429, retryAfterMs: 0, requestId: "attempt-1"}))
      .toMatchObject({statusCode: 429, retryAfterMs: 0, requestId: "attempt-1"});
  });
  it.each([undefined, new Date(), new Map(), new Error("original"), {nested: undefined}, {value: NaN},
    {value: 1n}, {items: Array(1)}])("rejects non-JSON diagnostics (%s)", metadata => {
    expect(() => snapshotProviderFailure({...failure(), metadata})).toThrow(TypeError);
  });
  it("does not invoke diagnostic accessors", () => {
    const metadata = {get value() {throw new Error("must not invoke");}};
    expect(() => snapshotProviderFailure({...failure(), metadata})).toThrow(TypeError);
  });
  it("preserves diagnostic field names as data without changing the snapshot prototype", () => {
    const metadata = JSON.parse('{"__proto__":{"detail":"retained"},"nested":{"constructor":"data"}}');
    const result = snapshotProviderFailure({...failure(), metadata});
    expect(Object.getPrototypeOf(result.metadata)).toBe(Object.prototype);
    expect(Object.hasOwn(result.metadata, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(result.metadata))).toEqual(metadata);
  });
  it("rejects cycles and unsupported result fields", () => {
    const metadata: Record<string, unknown> = {}; metadata.self = metadata;
    expect(() => snapshotProviderFailure({...failure(), metadata})).toThrow(/cycles/);
    expect(() => snapshotProviderFailure({...failure(), retryable: true})).toThrow(/unsupported field/);
  });
  it.each([{statusCode: 0}, {retryAfterMs: -1}, {retryAfterMs: Infinity}, {requestId: ""}])("validates provided values (%s)", fields => {
    expect(() => snapshotProviderFailure({...failure(), ...fields})).toThrow(TypeError);
  });
});
