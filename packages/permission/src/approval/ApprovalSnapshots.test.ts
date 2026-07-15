import { describe, expect, it } from "vitest";
import {
  snapshotApprovalDecisionSubmission,
  snapshotApprovalReviewerDescriptor,
  snapshotApprovalReviewInput,
} from "./ApprovalSnapshots.js";
import type { ApprovalReviewInput } from "./ApprovalContracts.js";

describe("approval transport snapshots", () => {
  it("rebuilds immutable reviewer and review input projections from safe fields", () => {
    const descriptor = snapshotApprovalReviewerDescriptor({
      id: "reviewer.user",
      kind: "user",
      displayName: "User",
      source: "host",
      metadata: { safe: true, nested: { value: 1 } },
      secret: "drop",
    } as never, "user");
    const review = snapshotApprovalReviewInput({
      ...reviewInput(),
      secret: "drop",
    } as never);

    expect(descriptor).not.toHaveProperty("secret");
    expect(review).not.toHaveProperty("secret");
    expect(Object.isFrozen(descriptor.metadata)).toBe(true);
    expect(Object.isFrozen(review.request.payload)).toBe(true);
  });

  it("transport-normalizes permission arrays without granting authority", () => {
    const submission = snapshotApprovalDecisionSubmission({
      submissionId: "submission.1",
      runId: "run.1",
      requestId: "request.1",
      pendingVersion: 1,
      optionId: "grant.run",
      grantedPermissions: {
        fileSystem: {
          read: ["/work/b", "/work/a", "/work/a"],
          write: ["/work/z"],
          secret: true,
        },
        network: {
          enabled: true,
          domains: ["b.example", "a.example", "a.example"],
          secret: true,
        },
        secret: true,
      },
      reason: "Needed for the task.",
      secret: "drop",
    } as never);

    expect(submission.grantedPermissions).toEqual({
      fileSystem: {
        read: ["/work/a", "/work/b"],
        write: ["/work/z"],
      },
      network: { enabled: true, domains: ["a.example", "b.example"] },
    });
    expect(submission).not.toHaveProperty("secret");
    expect(Object.isFrozen(submission.grantedPermissions)).toBe(true);
  });

  it("rejects malformed correlation and descriptor kinds", () => {
    expect(() => snapshotApprovalReviewerDescriptor({
      id: "reviewer.auto",
      kind: "auto_review",
      displayName: "Auto",
      source: "test",
      metadata: {},
    }, "user")).toThrow("must be 'user'");

    expect(() => snapshotApprovalReviewInput({
      ...reviewInput(),
      request: { ...reviewInput().request, runId: "run.other" },
    } as ApprovalReviewInput)).toThrow("correlation is inconsistent");
  });
});

function reviewInput(): ApprovalReviewInput {
  return {
    request: {
      id: "request.1",
      runId: "run.1",
      actionId: "action.1",
      actionFingerprint: "sha256:action.1",
      category: "mcpToolCall",
      reason: "Review MCP call.",
      subject: {
        runId: "run.1",
        actionId: "action.1",
        actionFingerprint: "sha256:action.1",
        environmentId: "local",
        applicabilityKeyCount: 0,
      },
      payload: {
        serverId: "server.1",
        serverDisplayName: "Server",
        toolName: "read",
        safeArguments: { path: "README.md" },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        supportsSessionAuthority: false,
      },
      decisionOptions: [{
        id: "accept.action",
        kind: "accept",
        scope: "action",
        label: "Accept",
        description: null,
      }],
      createdAt: "2026-07-15T00:00:00.000Z",
      deadlineAt: "2026-07-15T00:01:00.000Z",
    },
    pendingVersion: 1,
    context: {
      workspaceTrustState: "trusted",
      ruleOutcome: "prompt",
      currentAuthority: {
        fileSystemRead: true,
        fileSystemWrite: false,
        network: false,
      },
      annotations: {},
    },
  };
}
