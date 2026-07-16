import { describe, expect, it } from "vitest";
import {
  ActionContractValidationError,
  canonicalPathIdentityKey,
  createCanonicalExecutableIdentity,
  createCanonicalNetworkEndpoint,
  createCanonicalPathIdentity,
  createCanonicalRemoteServerIdentity,
  createCanonicalWorkspaceIdentity,
  createFileBaseline,
} from "./index.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

describe("canonical Action identities", () => {
  it("canonicalizes Windows paths while retaining a case-insensitive comparison key", () => {
    const identity = createCanonicalPathIdentity({
      platform: "win32",
      path: "d:\\Work\\Repo\\src\\..\\file.ts",
      resolvedPath: "D:\\Work\\Repo\\file.ts",
      workspaceRootId: "repo",
      resolutionFingerprint: DIGEST_A,
    });

    expect(identity).toEqual({
      platform: "win32",
      canonicalPath: "D:/Work/Repo/file.ts",
      comparisonKey: "d:/work/repo/file.ts",
      resolvedPath: "D:/Work/Repo/file.ts",
      resolvedComparisonKey: "d:/work/repo/file.ts",
      workspaceRootId: "repo",
      resolutionFingerprint: DIGEST_A,
    });
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it("keeps lexical and resolved path identity distinct for links", () => {
    const identity = createCanonicalPathIdentity({
      platform: "win32",
      path: "D:/workspace/link/file.ts",
      resolvedPath: "D:/outside/file.ts",
      workspaceRootId: "repo",
      resolutionFingerprint: DIGEST_B,
    });

    expect(identity.canonicalPath).toBe("D:/workspace/link/file.ts");
    expect(identity.resolvedPath).toBe("D:/outside/file.ts");
    expect(identity.resolutionFingerprint).toBe(DIGEST_B);
  });

  it("uses the resolved target to identify aliases of the same existing object", () => {
    const first = createCanonicalPathIdentity({
      ...path("D:/workspace/link/file.ts"),
      resolvedPath: "D:/workspace/real/file.ts",
    });
    const second = createCanonicalPathIdentity({
      ...path("D:/workspace/real/file.ts"),
      resolvedPath: "D:/workspace/real/file.ts",
    });

    expect(first.resolvedComparisonKey).toBe(second.resolvedComparisonKey);
  });

  it("binds workspace-root membership into full path identity", () => {
    const inWorkspace = createCanonicalPathIdentity(path("D:/workspace/file.ts"));
    const outsideWorkspace = createCanonicalPathIdentity({
      ...path("D:/workspace/file.ts"),
      workspaceRootId: null,
    });

    expect(canonicalPathIdentityKey(inWorkspace))
      .not.toBe(canonicalPathIdentityKey(outsideWorkspace));
  });

  it("sorts workspace roots and rejects duplicate Windows paths case-insensitively", () => {
    const workspace = createCanonicalWorkspaceIdentity({
      workspaceId: "workspace.main",
      roots: [root("z", "D:/z"), root("a", "C:/a")],
    });
    expect(workspace.roots.map(({ rootId }) => rootId)).toEqual(["a", "z"]);

    expect(() => createCanonicalWorkspaceIdentity({
      workspaceId: "workspace.main",
      roots: [root("one", "D:/Repo"), root("two", "d:/repo")],
    })).toThrowError(expect.objectContaining({ code: "canonical_duplicate" }));
  });

  it("canonicalizes concrete domains and IPv6 endpoints", () => {
    expect(createCanonicalNetworkEndpoint({
      transport: "tcp",
      host: "EXAMPLE.COM.",
      port: 443,
      applicationProtocol: "HTTPS",
    })).toEqual({
      transport: "tcp",
      host: "example.com",
      port: 443,
      applicationProtocol: "https",
    });
    expect(createCanonicalNetworkEndpoint({
      transport: "tcp",
      host: "2001:0db8::1",
      port: 443,
      applicationProtocol: "https",
    }).host).toBe("[2001:db8::1]");
  });

  it("rejects endpoint wildcards, credentials, and invalid ports", () => {
    expect(() => endpoint("*.example.com", 443)).toThrowError(
      expect.objectContaining({ code: "canonical_endpoint_invalid" }),
    );
    expect(() => endpoint("user@example.com", 443)).toThrowError(
      expect.objectContaining({ code: "canonical_endpoint_invalid" }),
    );
    expect(() => endpoint("example.com?token=value", 443)).toThrowError(
      expect.objectContaining({ code: "canonical_endpoint_invalid" }),
    );
    expect(() => endpoint("example.com", 0)).toThrowError(
      expect.objectContaining({ code: "canonical_endpoint_invalid" }),
    );
  });

  it("requires a content-bound present file for executable identity", () => {
    const executable = createCanonicalExecutableIdentity({
      path: path("C:/tools/node.exe"),
      baseline: fileBaseline(),
    });
    expect(executable.baseline.contentDigest).toBe(DIGEST_B);

    expect(() => createCanonicalExecutableIdentity({
      path: path("C:/tools/node.exe"),
      baseline: { kind: "absent" },
    })).toThrowError(expect.objectContaining({ code: "canonical_contract_invalid" }));
  });

  it("rejects contradictory remote transport and endpoint combinations", () => {
    expect(() => createCanonicalRemoteServerIdentity({
      serverId: "mcp.local",
      registrationFingerprint: "registration:1",
      transport: "stdio",
      endpoint: endpoint("localhost", 3000),
    })).toThrowError(expect.objectContaining({ code: "canonical_contract_invalid" }));
  });

  it("rejects malformed digests with a typed path", () => {
    try {
      createFileBaseline({
        ...fileBaseline(),
        contentDigest: "not-a-digest",
      });
      expect.fail("Expected validation failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(ActionContractValidationError);
      expect(error).toMatchObject({
        code: "canonical_digest_invalid",
        path: "baseline.contentDigest",
      });
    }
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

function root(rootId: string, value: string) {
  return {
    rootId,
    platform: "win32" as const,
    path: value,
    resolvedPath: value,
    resolutionFingerprint: DIGEST_A,
  };
}

function endpoint(host: string, port: number) {
  return createCanonicalNetworkEndpoint({
    transport: "tcp",
    host,
    port,
    applicationProtocol: "https",
  });
}

function fileBaseline() {
  return {
    kind: "present" as const,
    entryKind: "file" as const,
    objectIdentity: {
      kind: "win32" as const,
      volumeId: "volume-1",
      fileId: "file-1",
    },
    contentDigest: DIGEST_B,
  };
}
