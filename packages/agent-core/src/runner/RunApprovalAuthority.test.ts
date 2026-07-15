import { describe, expect, it } from "vitest";
import type { ValidatedApprovalDecision } from "@agent-anything/permission";
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
});

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
