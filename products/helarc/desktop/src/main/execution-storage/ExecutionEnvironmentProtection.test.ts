import {describe, expect, it} from "vitest";
import {ExecutionEnvironmentProtection} from "./ExecutionEnvironmentProtection.js";
import {environmentFixtureCipher} from "./fixtures/ExecutionEnvironmentFixture.js";

describe("execution environment protection", () => {
  it("protects values, verifies them after restart and preserves the sealed replay representation", () => {
    const first = new ExecutionEnvironmentProtection(environmentFixtureCipher());
    const original = {Path: "tools", PRIVATE_VALUE: "test-private-value", EMPTY: ""};
    const sealed = first.protect(original);
    expect(JSON.stringify(sealed)).not.toContain("test-private-value");
    expect(first.protect({...original})).toEqual(sealed);
    const restored = new ExecutionEnvironmentProtection(environmentFixtureCipher());
    expect(restored.restore(sealed)).toEqual(original);
    expect(restored.protect(original)).toEqual(sealed);
    expect(() => restored.restore({...sealed, digest: `sha256:${"0".repeat(64)}`})).toThrow("digest_mismatch");
    expect(() => restored.restore({...sealed, ciphertext: "corrupt"})).toThrow("decryption_failed");
  });
  it("never persists plaintext when encryption is unavailable", () => {
    const protection = new ExecutionEnvironmentProtection();
    expect(() => protection.protect({SECRET: "private"})).toThrow("encryption_unavailable");
  });
});
