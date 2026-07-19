import { describe, expect, it } from "vitest";
import type { ManagedPermissionConstraints } from "@agent-anything/governance";
import { resolvePermissionProfile } from "@agent-anything/permission";
import type { ResolvedRunPermissionConfig } from "../run/RunPermissionConfig.js";
import { preparePermissionRequestAction } from "./PermissionRequestAction.js";

describe("request_permissions Action", () => {
  it("uses the selected resolved root as the only relative-path base", () => {
    const config = permissionConfig();
    const first = preparePermissionRequestAction({
      actionInput: {
        rootId: "root_b",
        permissions: { fileSystem: { write: ["output.txt"] } },
        reason: "Write the generated output.",
      },
      config,
    });
    const second = preparePermissionRequestAction({
      actionInput: {
        rootId: "root_b",
        permissions: { fileSystem: { write: ["output.txt"] } },
        reason: "Write the generated output.",
      },
      config,
    });

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status !== "ready" || second.status !== "ready") {
      throw new Error("Expected prepared permission request.");
    }
    expect(first.request).toMatchObject({
      rootId: "root_b",
      cwd: "D:/beta",
      cwdDisplay: "root_b",
      permissions: { fileSystem: { write: ["D:/beta/output.txt"] } },
    });
    expect(first.request.actionFingerprint).toBe(second.request.actionFingerprint);
    expect(first.request.actionFingerprint).not.toContain(" ");
  });

  it("rejects a canonical request that exceeds managed authority", () => {
    const config = permissionConfig({
      ...managedConstraints(),
      network: { enabled: false, allowedDomains: [], deniedDomains: [] },
    });
    const result = preparePermissionRequestAction({
      actionInput: {
        rootId: "root_a",
        permissions: { network: { enabled: true, domains: ["example.com"] } },
        reason: "Fetch dependency metadata.",
      },
      config,
    });

    expect(result).toMatchObject({
      status: "managed_denied",
      code: "permissions_managed_network_denied",
      request: { rootId: "root_a" },
    });
  });
});

function permissionConfig(
  constraints: ManagedPermissionConstraints = managedConstraints(),
): ResolvedRunPermissionConfig {
  return {
    permissionProfile: resolvePermissionProfile({
      profileId: ":read-only",
      profiles: [],
      environment: {
        environmentId: "local-test",
        platform: "win32",
        workspaceRoots: [
          { rootId: "root_a", path: "C:/alpha" },
          { rootId: "root_b", path: "D:/beta" },
        ],
      },
      managedConstraints: constraints,
    }),
    approvalPolicy: "never",
    reviewer: null,
    rules: [],
    networkRules: [],
    managedConstraints: constraints,
    sessionAuthority: null,
    persistentPolicyAmendments: null,
    approvalLimits: {
      maxRequestsPerRun: 8,
      maxRequestsPerActionFingerprint: 2,
      maxConsecutiveDeclines: 3,
      maxConsecutiveReviewFailures: 3,
    },
    authorityApplicationLimits: { commitTimeoutMs: 1_000 },
  };
}

function managedConstraints(): ManagedPermissionConstraints {
  return {
    constraintSetId: "managed-test",
    selectableProfiles: { allowedProfileIds: null, deniedProfileIds: [] },
    fileSystem: [],
    network: { enabled: null, allowedDomains: [], deniedDomains: [] },
    allowUnenforcedExecution: false,
  };
}
