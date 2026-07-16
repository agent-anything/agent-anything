import { createRunCancellationController } from "@agent-anything/agent-core";
import { createUserApprovalReviewBridge } from "@agent-anything/agent-core/host";
import type { ApprovalReviewerPort } from "@agent-anything/permission";
import { describe, expect, it } from "vitest";
import { createHelarcPermissionComposition } from "./HelarcPermissionComposition.js";

describe("Helarc permission composition", () => {
  it("maps Ask for approval to workspace, on-request, and user review", async () => {
    const bridge = createUserApprovalReviewBridge({
      runId: "run.1",
      descriptor: {
        id: "user.1",
        kind: "user",
        displayName: "User",
        source: "test",
        metadata: {},
      },
    });
    const composition = await createHelarcPermissionComposition({
      ...baseInput(),
      preset: "ask_for_approval",
      userApprovalBridge: bridge,
    });

    expect(composition.permissions).toMatchObject({
      permissionProfile: {
        id: "helarc-workspace-disabled",
        enforcement: "disabled",
        process: { unrestricted: false },
      },
      approvalPolicy: "on-request",
      reviewer: { kind: "user", reviewer: bridge },
    });
    expect(composition.userApprovalBridge).toBe(bridge);
  });

  it("requires an explicit automatic reviewer for Approve for me", async () => {
    await expect(createHelarcPermissionComposition({
      ...baseInput(),
      preset: "approve_for_me",
    })).rejects.toThrow("requires an explicit automatic reviewer");

    const reviewer: ApprovalReviewerPort = {
      async review() {
        return {
          status: "failed",
          failure: {
            code: "approval_reviewer_unavailable",
            message: "not used",
            retryable: false,
            metadata: {},
          },
        };
      },
    };
    const composition = await createHelarcPermissionComposition({
      ...baseInput(),
      preset: "approve_for_me",
      automaticReviewer: {
        bindingId: "auto.binding",
        kind: "auto_review",
        reviewer,
        descriptor: {
          id: "auto.1",
          kind: "auto_review",
          displayName: "Automatic reviewer",
          source: "test",
          metadata: {},
        },
        reviewTimeoutMs: 1_000,
      },
    });

    expect(composition.permissions.reviewer?.kind).toBe("auto_review");
    expect(composition.userApprovalBridge).toBeNull();
  });

  it("maps Full access to danger-full-access and no reviewer", async () => {
    const composition = await createHelarcPermissionComposition({
      ...baseInput(),
      preset: "full_access",
    });

    expect(composition.permissions).toMatchObject({
      permissionProfile: {
        id: "helarc-full-access-disabled",
        enforcement: "disabled",
        process: { unrestricted: true },
      },
      approvalPolicy: "never",
      reviewer: null,
    });
  });
});

function baseInput() {
  return {
    runId: "run.1",
    hostSessionId: "session.1",
    workspace: {
      id: "workspace.1",
      rootRef: "D:\\workspace",
      trustState: "trusted" as const,
      metadata: {},
    },
    workspaceRoots: [{ rootId: "workspace.1", path: "D:\\workspace" }],
    platform: "win32" as const,
    enforcement: "disabled" as const,
    cancellation: createRunCancellationController({ runId: "run.1" }),
  };
}
