import { describe, expect, it } from "vitest";
import { RunTreeApprovalAccount } from "./RunTreeApprovalAccount.js";

describe("RunTreeApprovalAccount", () => {
  it("shares equivalent-operation and active-review limits across sibling Runs", () => {
    const account = createAccount({ maxRequestsPerOperationFingerprint: 2, maxActiveReviews: 2 });
    expect(account.admit(request("approval-1", "child-1", "action-1", "same"))).toMatchObject({
      status: "accepted",
    });
    expect(account.admit(request("approval-2", "child-2", "action-2", "same"))).toMatchObject({
      status: "accepted",
    });
    expect(account.admit(request("approval-3", "child-3", "action-3", "other"))).toEqual({
      status: "limit_exceeded",
      code: "approval_tree_active_limit_exceeded",
      revision: 2,
    });
    account.settle("approval-1", "approved");
    expect(account.admit(request("approval-3", "child-3", "action-3", "same"))).toEqual({
      status: "limit_exceeded",
      code: "approval_tree_operation_limit_exceeded",
      revision: 3,
    });
  });

  it("tracks decline and reviewer-failure fatigue independently and settles once", () => {
    const account = createAccount({
      maxConsecutiveDeclines: 1,
      maxConsecutiveReviewerFailures: 1,
    });
    account.admit(request("approval-1", "child-1", "action-1", "one"));
    account.settle("approval-1", "declined");
    expect(account.admit(request("approval-2", "child-2", "action-2", "two"))).toMatchObject({
      status: "limit_exceeded",
      code: "approval_tree_decline_limit_exceeded",
    });
    expect(() => account.settle("approval-1", "approved")).toThrow("not active");
    expect(() => account.admit(request("approval-1", "child-2", "action-2", "two")))
      .toThrow("already admitted");
  });
});

function createAccount(overrides: Partial<ConstructorParameters<typeof RunTreeApprovalAccount>[0]> = {}) {
  return new RunTreeApprovalAccount({
    maxTotalRequests: 8,
    maxRequestsPerOperationFingerprint: 4,
    maxConsecutiveDeclines: 3,
    maxConsecutiveReviewerFailures: 3,
    maxActiveReviews: 4,
    ...overrides,
  });
}

function request(
  requestId: string,
  runId: string,
  actionId: string,
  operationFingerprint: string,
) {
  return {
    requestId,
    runId,
    actionId,
    authorityRevision: `${runId}:authority`,
    workspaceId: "workspace-1",
    environmentId: "local",
    operationFingerprint,
  };
}
