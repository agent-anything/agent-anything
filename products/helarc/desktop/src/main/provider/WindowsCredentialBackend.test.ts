import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NativeWindowsCredentialBackend } from "./WindowsCredentialBackend.js";

describe.skipIf(process.platform !== "win32" || process.arch !== "x64")("Windows generic credentials", () => {
  it("round-trips only a unique dummy entry with Unicode and never overwrites a target", async () => {
    const backend = new NativeWindowsCredentialBackend();
    const target = `Helarc/Provider/provider-${randomUUID()}-${randomUUID()}`;
    const secret = "dummy-\u4e2d\u6587-\u00e9-key";
    expect(await backend.available()).toBe(true);
    expect(await backend.read(target, "utf16le")).toBeNull();
    try {
      await backend.create(target, secret);
      expect(await backend.read(target, "utf16le")).toBe(secret);
      await expect(backend.create(target, "replacement")).rejects.toThrow("operation failed");
      expect(await backend.read(target, "utf16le")).toBe(secret);
      await expect(backend.read(target, "utf8")).rejects.toThrow("operation failed");
    } finally { await backend.delete(target); }
    expect(await backend.read(target, "utf16le")).toBeNull();
    await backend.delete(target);
  });
  it("rejects external writes/deletes and oversized secrets before touching any credential", async () => {
    const backend = new NativeWindowsCredentialBackend();
    await expect(backend.create("NotHelarc/test", "dummy")).rejects.toThrow();
    await expect(backend.delete("NotHelarc/test")).rejects.toThrow();
    const target = `Helarc/Provider/provider-${randomUUID()}-${randomUUID()}`;
    await expect(backend.create(target, "x".repeat(1281))).rejects.toThrow();
    expect(await backend.read(target, "utf16le")).toBeNull();
  });
  it("does not use another storage when its helper is unavailable", async () => {
    const backend = new NativeWindowsCredentialBackend("D:/nonexistent-helarc-helper");
    expect(await backend.available()).toBe(false);
    await expect(backend.read("Example/DeepSeek", "utf16le")).rejects.toThrow("Build");
  });
});
