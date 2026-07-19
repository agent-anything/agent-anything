import { describe, expect, it } from "vitest";
import { capabilityEffectKey, createActionEffectSet } from "./CapabilityEffect.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

describe("ActionEffectSet", () => {
  it("represents effect-free execution explicitly", () => {
    const effectSet = createActionEffectSet({ kind: "effect_free" });
    expect(effectSet).toEqual({ kind: "effect_free" });
    expect(Object.isFrozen(effectSet)).toBe(true);
  });

  it("canonicalizes nested targets and orders effects by canonical key", () => {
    const effectSet = createActionEffectSet({
      kind: "effects",
      values: [
        {
          kind: "network",
          operation: "connect",
          endpoints: [{
            transport: "tcp",
            host: "EXAMPLE.COM",
            port: 443,
            applicationProtocol: "HTTPS",
          }],
        },
        {
          kind: "file_system",
          operation: "read",
          targets: [path("D:/workspace/b"), path("D:/workspace/A")],
        },
      ],
    });

    if (effectSet.kind !== "effects") throw new Error("Expected effects.");
    expect(effectSet.values.map(({ kind }) => kind)).toEqual(["file_system", "network"]);
    const fileEffect = effectSet.values[0];
    if (fileEffect?.kind !== "file_system") throw new Error("Expected file effect.");
    expect(fileEffect.targets.map(({ path: target }) => target.comparisonKey)).toEqual([
      "d:/workspace/a",
      "d:/workspace/b",
    ]);
    expect(Object.isFrozen(fileEffect.targets)).toBe(true);
    expect(capabilityEffectKey(fileEffect)).toContain("file_system:read");
  });

  it("rejects empty effects and duplicate canonical targets", () => {
    expect(() => createActionEffectSet({ kind: "effects", values: [] })).toThrowError(
      expect.objectContaining({ code: "canonical_effect_invalid" }),
    );
    expect(() => createActionEffectSet({
      kind: "effects",
      values: [{
        kind: "file_system",
        operation: "write",
        targets: [path("D:/workspace/File"), path("d:/workspace/file")],
      }],
    })).toThrowError(expect.objectContaining({ code: "canonical_duplicate" }));

    expect(() => createActionEffectSet({
      kind: "effects",
      values: [
        {
          kind: "file_system",
          operation: "read",
          targets: [path("D:/workspace/file")],
        },
        {
          kind: "file_system",
          operation: "read",
          targets: [{ ...path("d:/workspace/File"), resolutionFingerprint: DIGEST_B }],
        },
      ],
    })).toThrowError(expect.objectContaining({ code: "canonical_duplicate" }));

    expect(() => createActionEffectSet({
      kind: "effects",
      values: [{
        kind: "file_system",
        operation: "write",
        targets: [
          { ...path("D:/workspace/link/file"), resolvedPath: "D:/workspace/real/file" },
          { ...path("D:/workspace/real/file"), resolvedPath: "D:/workspace/real/file" },
        ],
      }],
    })).toThrowError(expect.objectContaining({ code: "canonical_duplicate" }));
  });

  it("rejects unknown effect variants instead of treating them as safe", () => {
    expect(() => createActionEffectSet({
      kind: "effects",
      values: [{ kind: "host_operation", operation: "open" } as never],
    })).toThrowError(expect.objectContaining({ code: "canonical_effect_invalid" }));
  });

  it("binds process effects to an executable baseline", () => {
    const effectSet = createActionEffectSet({
      kind: "effects",
      values: [{
        kind: "process",
        operation: "spawn",
        executable: {
          path: path("C:/tools/git.exe"),
          baseline: {
            kind: "present",
            entryKind: "file",
            objectIdentity: { kind: "win32", volumeId: "volume-1", fileId: "git-1" },
            contentDigest: DIGEST_B,
          },
        },
      }],
    });
    if (effectSet.kind !== "effects") throw new Error("Expected effects.");
    expect(capabilityEffectKey(effectSet.values[0]!)).toContain(DIGEST_B);
  });
});

function path(value: string) {
  return {
    platform: "win32" as const,
    path: value,
    resolvedPath: value,
    workspaceRootId: "repo",
    resolutionFingerprint: DIGEST_A,
  };
}
