import { describe, expect, it } from "vitest";
import {
  createCanonicalActionOperation,
  createCanonicalEffectivePermissions,
  createSafeActionSummary,
  createTargetStateAssertions,
} from "./index.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

describe("canonical Action operation contracts", () => {
  it("preserves semantic filesystem order and requires contiguous sequence", () => {
    const operation = createCanonicalActionOperation({
      kind: "file_system",
      operations: [
        { sequence: 0, operation: "create", target: path("D:/workspace/a.txt") },
        { sequence: 1, operation: "move", source: path("D:/workspace/a.txt"), destination: path("D:/workspace/b.txt") },
      ],
      parametersDigest: DIGEST_A,
    });
    if (operation.kind !== "file_system") throw new Error("Expected filesystem operation.");
    expect(operation.operations.map(({ operation: kind }) => kind)).toEqual(["create", "move"]);
    expect(Object.isFrozen(operation.operations)).toBe(true);

    expect(() => createCanonicalActionOperation({
      kind: "file_system",
      operations: [{ sequence: 1, operation: "read", target: path("D:/workspace/a.txt") }],
      parametersDigest: DIGEST_A,
    })).toThrowError(expect.objectContaining({ code: "canonical_operation_invalid" }));
  });

  it("rejects a transfer whose canonical source and destination are equal", () => {
    expect(() => createCanonicalActionOperation({
      kind: "file_system",
      operations: [{
        sequence: 0,
        operation: "copy",
        source: path("D:/workspace/File.txt"),
        destination: path("d:/workspace/file.txt"),
      }],
      parametersDigest: DIGEST_A,
    })).toThrowError(expect.objectContaining({ code: "canonical_operation_invalid" }));
  });

  it("keeps secret references structural in process arguments", () => {
    const operation = createCanonicalActionOperation({
      kind: "process",
      operation: "spawn",
      executable: executable("C:/tools/tool.exe"),
      arguments: [
        { kind: "literal", value: "--token" },
        { kind: "secret_reference", reference: "secret:provider" },
        { kind: "literal", value: "" },
      ],
      cwd: path("D:/workspace"),
      environmentDigest: DIGEST_B,
    });
    if (operation.kind !== "process") throw new Error("Expected process operation.");
    expect(operation.arguments[1]).toEqual({
      kind: "secret_reference",
      reference: "secret:provider",
    });
    expect(operation.arguments[2]).toEqual({ kind: "literal", value: "" });
  });
});

describe("canonical effective permissions", () => {
  it("uses explicit none, restricted, and unrestricted scopes", () => {
    const permissions = createCanonicalEffectivePermissions({
      enforcement: "disabled",
      fileSystem: {
        read: { kind: "restricted", values: [path("D:/workspace/b"), path("D:/workspace/A")] },
        write: { kind: "none" },
      },
      process: { spawn: { kind: "none" } },
      network: { connect: { kind: "unrestricted" } },
      remoteTool: { invoke: { kind: "none" } },
    });
    expect(permissions.fileSystem.read.kind).toBe("restricted");
    if (permissions.fileSystem.read.kind !== "restricted") throw new Error("Expected restricted.");
    expect(permissions.fileSystem.read.values.map(({ path: target }) => target.comparisonKey)).toEqual([
      "d:/workspace/a",
      "d:/workspace/b",
    ]);
    expect(permissions.network.connect).toEqual({ kind: "unrestricted" });
  });

  it("rejects empty restricted scopes and duplicate targets", () => {
    expect(() => effectiveWithRead([])).toThrowError(
      expect.objectContaining({ code: "canonical_permission_invalid" }),
    );
    expect(() => effectiveWithRead([path("D:/workspace/a"), path("d:/workspace/A")])).toThrowError(
      expect.objectContaining({ code: "canonical_duplicate" }),
    );
  });
});

describe("target assertions and safe summaries", () => {
  it("sorts assertions, freezes them, and rejects duplicate assertion identities", () => {
    const assertions = createTargetStateAssertions([
      {
        kind: "executor_registration",
        expected: { id: "executor", version: "1", invocationContractVersion: "1" },
        registrationFingerprint: "registration:1",
      },
      {
        kind: "adapter_registration",
        expected: { id: "adapter", version: "1", inputSchemaVersion: "1" },
        registrationFingerprint: "registration:1",
      },
      { kind: "canonical_path_identity", expected: path("D:/workspace/a") },
    ]);
    expect(assertions.map(({ kind }) => kind)).toEqual([
      "adapter_registration",
      "canonical_path_identity",
      "executor_registration",
    ]);
    expect(Object.isFrozen(assertions)).toBe(true);

    expect(() => createTargetStateAssertions([
      { kind: "canonical_path_identity", expected: path("D:/workspace/A") },
      { kind: "canonical_path_identity", expected: path("d:/workspace/a") },
    ])).toThrowError(expect.objectContaining({ code: "canonical_duplicate" }));
  });

  it("keeps safe review data separate and enforces category shape", () => {
    const summary = createSafeActionSummary({
      kind: "file_system",
      headline: "Move one file",
      operations: [{
        operation: "move",
        sourceLabel: "a.txt",
        destinationLabel: "b.txt",
      }],
    });
    expect(summary).toEqual({
      schemaVersion: 1,
      kind: "file_system",
      headline: "Move one file",
      operations: [{ operation: "move", sourceLabel: "a.txt", destinationLabel: "b.txt" }],
    });

    expect(() => createSafeActionSummary({
      kind: "file_system",
      headline: "Read one file",
      operations: [{
        operation: "read",
        sourceLabel: "a.txt",
        destinationLabel: "b.txt",
      }],
    })).toThrowError(expect.objectContaining({ code: "safe_summary_invalid" }));
  });
});

function effectiveWithRead(values: ReturnType<typeof path>[]) {
  return createCanonicalEffectivePermissions({
    enforcement: "managed",
    fileSystem: { read: { kind: "restricted", values }, write: { kind: "none" } },
    process: { spawn: { kind: "none" } },
    network: { connect: { kind: "none" } },
    remoteTool: { invoke: { kind: "none" } },
  });
}

function path(value: string) {
  return {
    platform: "win32" as const,
    path: value,
    resolvedPath: value,
    workspaceRootId: "repo",
    resolutionFingerprint: DIGEST_A,
  };
}

function executable(value: string) {
  return {
    path: path(value),
    baseline: {
      kind: "present" as const,
      entryKind: "file" as const,
      objectIdentity: { kind: "win32" as const, volumeId: "volume-1", fileId: "file-1" },
      contentDigest: DIGEST_B,
    },
  };
}
