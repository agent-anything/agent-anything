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
      detail: detail("active_reviews", 2),
      revision: 2,
    });
    account.settle("approval-1", "approved");
    expect(account.admit(request("approval-3", "child-3", "action-3", "same"))).toEqual({
      status: "limit_exceeded",
      code: "approval_tree_operation_limit_exceeded",
      detail: detail("equivalent_operation_requests", 2),
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

  it("keeps accounting across root and sibling Runs with both request quotas unbounded", () => {
    const limits = { maxTotalRequests: null, maxRequestsPerOperationFingerprint: null };
    const account = createAccount(limits);
    for (let index = 0; index < 24; index += 1) {
      const id = `approval-${index}`;
      expect(account.admit(request(id, index % 2 === 0 ? "root" : "child", `action-${index}`, "same")))
        .toMatchObject({status: "accepted"});
      account.settle(id, "approved");
    }
    expect(account.getSnapshot()).toMatchObject({
      limits, totalRequests: 24, settledRequests: 24, activeReviews: 0,
      uniqueOperationFingerprints: 1, maxEquivalentOperationRequests: 24,
      revision: 48, exhaustedCode: null,
    });
    expect(Object.isFrozen(account.getSnapshot().limits)).toBe(true);
  });

  it.each([
    {maxTotalRequests: 2, maxRequestsPerOperationFingerprint: null, quota: "total_requests", code: "approval_tree_total_limit_exceeded"},
    {maxTotalRequests: null, maxRequestsPerOperationFingerprint: 2, quota: "equivalent_operation_requests", code: "approval_tree_operation_limit_exceeded"},
  ] as const)("enforces the remaining finite $quota quota tree-wide", ({quota, code, ...limits}) => {
    const account = createAccount(limits);
    for (const runId of ["root", "child"]) {
      account.admit(request(runId, runId, `${runId}:action`, "same"));
      account.settle(runId, "approved");
    }
    const before = account.getSnapshot();
    const rejected = account.admit(request("sibling", "sibling", "sibling:action", "same"));
    expect(rejected).toEqual({status: "limit_exceeded", code, detail: detail(quota, 2), revision: 4});
    expect(account.getSnapshot()).toEqual(before);
    if (rejected.status !== "limit_exceeded") throw new Error("Expected rejection.");
    expect(Object.isFrozen(rejected.detail)).toBe(true);
    expect(rejected.detail.description).toContain("Retrying does not reset this cumulative quota.");
    if (quota === "equivalent_operation_requests") {
      expect(account.admit(request("different", "sibling", "new:action", "different"))).toMatchObject({status: "accepted"});
      expect(rejected.detail.limit.count).toBe(2);
    }
  });

  it.each([
    {settlement: "declined", quota: "consecutive_declines", code: "approval_tree_decline_limit_exceeded"},
    {settlement: "reviewer_failure", quota: "consecutive_reviewer_failures", code: "approval_tree_reviewer_failure_limit_exceeded"},
  ] as const)("retains $quota protection with unbounded request quotas", ({settlement, quota, code}) => {
    const account = createAccount({maxTotalRequests: null, maxRequestsPerOperationFingerprint: null,
      maxConsecutiveDeclines: 1, maxConsecutiveReviewerFailures: 1});
    account.admit(request("first", "root", "action", "same"));
    account.settle("first", settlement);
    expect(account.admit(request("second", "child", "next", "other")))
      .toMatchObject({status: "limit_exceeded", code, detail: detail(quota, 1)});
    const rejected = account.admit(request("third", "child", "third", "other"));
    if (rejected.status !== "limit_exceeded") throw new Error("Expected rejection.");
    expect(rejected.detail.description).not.toContain("Retrying does not reset");
  });

  it("retains the active-review limit with unbounded request quotas and releases it after settlement", () => {
    const account = createAccount({maxTotalRequests: null, maxRequestsPerOperationFingerprint: null, maxActiveReviews: 1});
    account.admit(request("first", "root", "action", "same"));
    expect(account.admit(request("second", "child", "next", "other")))
      .toMatchObject({status: "limit_exceeded", detail: detail("active_reviews", 1)});
    const rejected = account.admit(request("third", "child", "third", "other"));
    if (rejected.status !== "limit_exceeded") throw new Error("Expected rejection.");
    expect(rejected.detail.description).toContain("Active review capacity is released when reviews settle.");
    expect(rejected.detail.description).not.toContain("Retrying does not reset");
    account.settle("first", "approved");
    expect(account.admit(request("second", "child", "next", "other"))).toMatchObject({status: "accepted"});
  });

  it("allows null only for cumulative request quotas and rejects invalid numeric limits", () => {
    for (const field of ["maxTotalRequests", "maxRequestsPerOperationFingerprint", "maxConsecutiveDeclines",
      "maxConsecutiveReviewerFailures", "maxActiveReviews"] as const) {
      for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, undefined, "2"]) {
        expect(() => createAccount({[field]: value} as never)).toThrow(field);
      }
    }
    for (const field of ["maxConsecutiveDeclines", "maxConsecutiveReviewerFailures", "maxActiveReviews"]) {
      expect(() => createAccount({[field]: null} as never)).toThrow(field);
    }
  });
});

function detail(quota: string, limit: number) {
  return {kind: "capacity", stage: "approval_admission", scope: {owner: "agent-runtime", kind: "run_tree"},
    limit: {name: quota, count: limit, maximum: limit}, dispatch: "never_dispatched",
    description: expect.stringMatching(new RegExp(`across the whole run tree \\(${limit}/${limit}\\).*not a user denial; the action was never dispatched`))};
}

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
