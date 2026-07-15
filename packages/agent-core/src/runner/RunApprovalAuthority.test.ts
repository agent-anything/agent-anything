import { describe, expect, it } from "vitest";
import type {
  GrantedPermissions,
  ValidatedApprovalDecision,
} from "@agent-anything/permission";
import type { RunPermissionState } from "./RunPermissionState.js";
import {
  applyImmediateApprovalAuthority,
  consumeActionApprovalCoverage,
} from "./RunApprovalAuthority.js";

describe("Run approval authority", () => {
  it("consumes exact Action coverage once without broadening or reuse", () => {
    const decision: ValidatedApprovalDecision = {
      kind: "accept",
      optionId: "accept_action",
      actionAuthority: {
        id: "coverage_001",
        runId: "run_001",
        actionId: "action_001",
        actionFingerprint: "fingerprint_001",
        sourceRequestId: "request_001",
        grantedPermissions: null,
        validatedAt: "2026-07-15T00:00:00.000Z",
      },
    };
    const applied = applyImmediateApprovalAuthority({
      permission: permissionState(),
      decision,
    });
    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") throw new Error("Expected applied authority.");

    const wrongFingerprint = consumeActionApprovalCoverage({
      permission: applied.permission,
      runId: "run_001",
      actionId: "action_001",
      actionFingerprint: "fingerprint_other",
    });
    expect(wrongFingerprint.status).toBe("not_found");
    expect(wrongFingerprint.permission).toBe(applied.permission);

    const consumed = consumeActionApprovalCoverage({
      permission: applied.permission,
      runId: "run_001",
      actionId: "action_001",
      actionFingerprint: "fingerprint_001",
    });
    expect(consumed.status).toBe("consumed");
    expect(consumed.permission.actionCoverage[0]?.status).toBe("consumed");

    expect(consumeActionApprovalCoverage({
      permission: consumed.permission,
      runId: "run_001",
      actionId: "action_001",
      actionFingerprint: "fingerprint_001",
    }).status).toBe("not_found");
  });

  it("keeps Run permission grants inside the Run that received them", () => {
    const decision: ValidatedApprovalDecision = {
      kind: "grantPermissions",
      optionId: "grant_run",
      authority: {
        scope: "run",
        grant: {
          id: "run_grant_001",
          runId: "run_001",
          sourceRequestId: "request_001",
          sourceActionFingerprint: "fingerprint_001",
          permissions: grantedPermissions(),
          createdAt: "2026-07-15T00:00:00.000Z",
        },
      },
    };

    const firstRun = permissionState();
    const applied = applyImmediateApprovalAuthority({
      permission: firstRun,
      decision,
    });
    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") throw new Error("Expected applied authority.");

    expect(firstRun.runPermissionGrants).toEqual([]);
    expect(applied.permission.runPermissionGrants).toHaveLength(1);
    expect(permissionState().runPermissionGrants).toEqual([]);
  });
});

function grantedPermissions(): GrantedPermissions {
  return {
    fileSystem: { read: ["C:/workspace"] },
  } as unknown as GrantedPermissions;
}

function permissionState(): RunPermissionState {
  return {
    pendingApproval: null,
    approvalRecords: [],
    actionCoverage: [],
    runPermissionGrants: [],
    sessionAuthorityRecords: [],
    appliedPolicyAmendments: [],
    counters: {
      totalRequests: 0,
      requestsByActionFingerprint: [],
      consecutiveDeclines: 0,
      consecutiveReviewFailures: 0,
      lastPendingVersion: 0,
    },
  };
}
