import type { ManagedPermissionConstraints } from "@agent-anything/governance/managed-permission";
import { describe, expect, it } from "vitest";
import {
  canonicalizeAdditionalPermissions,
  validateGrantedPermissions,
} from "./PermissionDelta.js";

describe("permission deltas", () => {
  it("canonicalizes paths and domains into an immutable request upper bound", () => {
    const result = canonicalizeAdditionalPermissions({
      permissions: {
        fileSystem: {
          read: ["src", "./src"],
          write: ["D:\\Work\\Repo\\output"],
        },
        network: {
          enabled: true,
          domains: ["API.Example.COM.", "api.example.com"],
        },
      },
      cwd: "d:\\Work\\Repo",
      environment: windowsEnvironment(),
    });

    expect(result).toEqual({
      status: "valid",
      permissions: {
        fileSystem: {
          read: ["D:/Work/Repo/src"],
          write: ["D:/Work/Repo/output"],
        },
        network: { enabled: true, domains: ["api.example.com"] },
      },
    });
    if (result.status === "valid") {
      expect(Object.isFrozen(result.permissions)).toBe(true);
      expect(Object.isFrozen(result.permissions.fileSystem?.read)).toBe(true);
    }
  });

  it("allows a narrower read grant from requested write authority", () => {
    const requested = canonicalRequest({
      fileSystem: { write: ["/work/repo"] },
    });
    const result = validateGrantedPermissions({
      requested,
      granted: { fileSystem: { read: ["/work/repo/src"] } },
      cwd: "/work/repo",
      environment: portableEnvironment(),
      managedConstraints: noManagedConstraints(),
    });

    expect(result).toMatchObject({ status: "valid" });
  });

  it("rejects write authority outside the requested scope", () => {
    const requested = canonicalRequest({
      fileSystem: { read: ["/work/repo/src"] },
    });
    const result = validateGrantedPermissions({
      requested,
      granted: { fileSystem: { write: ["/work/repo"] } },
      cwd: "/work/repo",
      environment: portableEnvironment(),
      managedConstraints: noManagedConstraints(),
    });

    expect(result).toMatchObject({
      status: "invalid",
      code: "permissions_write_not_requested",
    });
  });

  it("rejects authority blocked by a managed filesystem ceiling", () => {
    const requested = canonicalRequest({
      fileSystem: { write: ["/work/repo"] },
    });
    const result = validateGrantedPermissions({
      requested,
      granted: { fileSystem: { write: ["/work/repo/secrets"] } },
      cwd: "/work/repo",
      environment: portableEnvironment(),
      managedConstraints: {
        ...noManagedConstraints(),
        fileSystem: [
          {
            target: {
              kind: "workspace_path",
              rootId: "repo",
              path: "secrets",
            },
            maximumAccess: "read",
          },
        ],
      },
    });

    expect(result).toMatchObject({
      status: "invalid",
      code: "permissions_managed_filesystem_denied",
    });
  });

  it("intersects requested and managed network authority", () => {
    const requested = canonicalRequest({
      network: {
        enabled: true,
        domains: ["*.example.com"],
      },
    });
    const constraints: ManagedPermissionConstraints = {
      ...noManagedConstraints(),
      network: {
        enabled: true,
        allowedDomains: ["api.example.com"],
        deniedDomains: ["blocked.example.com"],
      },
    };

    expect(
      validateGrantedPermissions({
        requested,
        granted: {
          network: { enabled: true, domains: ["api.example.com"] },
        },
        cwd: "/work/repo",
        environment: portableEnvironment(),
        managedConstraints: constraints,
      }),
    ).toMatchObject({ status: "valid" });

    expect(
      validateGrantedPermissions({
        requested,
        granted: {
          network: { enabled: true, domains: ["other.example.com"] },
        },
        cwd: "/work/repo",
        environment: portableEnvironment(),
        managedConstraints: constraints,
      }),
    ).toMatchObject({
      status: "invalid",
      code: "permissions_managed_network_denied",
    });
  });

  it("rejects empty permission objects", () => {
    expect(
      canonicalizeAdditionalPermissions({
        permissions: { network: { enabled: false } },
        cwd: "/work/repo",
        environment: portableEnvironment(),
      }),
    ).toMatchObject({ status: "invalid", code: "permissions_empty" });
  });
});

function canonicalRequest(permissions: Parameters<typeof canonicalizeAdditionalPermissions>[0]["permissions"]) {
  const result = canonicalizeAdditionalPermissions({
    permissions,
    cwd: "/work/repo",
    environment: portableEnvironment(),
  });
  if (result.status === "invalid") throw new Error(result.message);
  return result.permissions;
}

function portableEnvironment() {
  return {
    environmentId: "portable",
    platform: "posix" as const,
    workspaceRoots: [{ rootId: "repo", path: "/work/repo" }],
  };
}

function windowsEnvironment() {
  return {
    environmentId: "windows",
    platform: "win32" as const,
    workspaceRoots: [{ rootId: "repo", path: "D:\\Work\\Repo" }],
  };
}

function noManagedConstraints(): ManagedPermissionConstraints {
  return {
    constraintSetId: "none",
    selectableProfiles: { allowedProfileIds: null, deniedProfileIds: [] },
    fileSystem: [],
    network: { enabled: null, allowedDomains: [], deniedDomains: [] },
    allowUnenforcedExecution: true,
  };
}
