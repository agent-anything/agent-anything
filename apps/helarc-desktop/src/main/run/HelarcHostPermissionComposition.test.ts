import { createRunCancellationController } from "@agent-anything/agent-core/run";
import {
  createInMemoryHostPolicyAmendmentStore,
  createInMemoryHostSessionAuthorityStore,
  createUserApprovalReviewBridge,
} from "@agent-anything/host";
import type { ApprovalReviewerPort, SessionAuthorityPort } from "@agent-anything/permission";
import { describe, expect, it } from "vitest";
import { createHelarcHostPermissionComposition } from "./HelarcHostPermissionComposition.js";

describe("Helarc Host permission composition", () => {
  it("binds Ask for approval to the exact Run-scoped user bridge", async () => {
    const bridge = userBridge("run.1");
    const composition = await createHelarcHostPermissionComposition({
      ...baseInput(),
      preset: "ask_for_approval",
      userApprovalBridge: bridge,
    });

    expect(composition.userApprovalBridge).toBe(bridge);
    expect(composition.permissions).toMatchObject({
      permissionProfile: {
        id: "helarc-workspace-disabled",
        enforcement: "disabled",
        process: { unrestricted: false },
      },
      approvalPolicy: "on-request",
      reviewer: { kind: "user", reviewer: bridge },
    });
  });

  it("requires exactly the reviewer kind selected by each preset", async () => {
    await expect(createHelarcHostPermissionComposition({
      ...baseInput(),
      preset: "ask_for_approval",
    })).rejects.toThrow("requires an explicit user approval bridge");
    await expect(createHelarcHostPermissionComposition({
      ...baseInput(),
      preset: "ask_for_approval",
      userApprovalBridge: userBridge("run.other"),
    })).rejects.toThrow("Run identity does not match");
    await expect(createHelarcHostPermissionComposition({
      ...baseInput(),
      preset: "approve_for_me",
      userApprovalBridge: userBridge("run.1"),
    })).rejects.toThrow("requires an explicit automatic reviewer");
    await expect(createHelarcHostPermissionComposition({
      ...baseInput(),
      preset: "full_access",
      userApprovalBridge: userBridge("run.1"),
    })).rejects.toThrow("must not include an approval reviewer");
  });

  it("binds Approve for me and Full access without user transport fallback", async () => {
    const automaticReviewer = autoReviewer();
    const automatic = await createHelarcHostPermissionComposition({
      ...baseInput(),
      preset: "approve_for_me",
      automaticReviewer,
    });
    expect(automatic.permissions).toMatchObject({
      approvalPolicy: "on-request",
      reviewer: { kind: "auto_review", reviewer: automaticReviewer.reviewer },
    });
    expect(automatic.userApprovalBridge).toBeNull();

    const fullAccess = await createHelarcHostPermissionComposition({
      ...baseInput(),
      preset: "full_access",
    });
    expect(fullAccess.permissions).toMatchObject({
      permissionProfile: {
        id: "helarc-full-access-disabled",
        process: { unrestricted: true },
      },
      approvalPolicy: "never",
      reviewer: null,
    });
  });

  it("propagates initial authority-store failure before returning a composition", async () => {
    const unavailable: SessionAuthorityPort = {
      async listApplicable() {
        throw new Error("authority store unavailable");
      },
      async commit() {
        throw new Error("not reached");
      },
    };

    await expect(createHelarcHostPermissionComposition({
      ...baseInput(),
      preset: "ask_for_approval",
      userApprovalBridge: userBridge("run.1"),
      sessionAuthorityPort: unavailable,
    })).rejects.toThrow("authority store unavailable");
  });
});

function baseInput() {
  return {
    runId: "run.1",
    sessionId: "session.1",
    workspace: {
      id: "workspace.1",
      name: "Workspace",
      rootRef: "D:\\workspace",
      trustState: "trusted" as const,
      source: "test",
      policyRefs: [],
      metadata: {},
    },
    workspaceRoots: [{ rootId: "workspace.1", path: "D:\\workspace" }],
    platform: "win32" as const,
    enforcement: "disabled" as const,
    cancellation: createRunCancellationController({ runId: "run.1" }),
    userApprovalBridge: null,
    automaticReviewer: null,
    sessionAuthorityPort: createInMemoryHostSessionAuthorityStore({ maxRecords: 64 }),
    persistentPolicyAmendments: createInMemoryHostPolicyAmendmentStore({ maxRecords: 64 }),
  };
}

function userBridge(runId: string) {
  return createUserApprovalReviewBridge({
    runId,
    descriptor: {
      id: "reviewer.user",
      kind: "user",
      displayName: "User",
      source: "test",
      metadata: {},
    },
  });
}

function autoReviewer() {
  const reviewer: ApprovalReviewerPort = {
    async review() {
      return {
        status: "failed" as const,
        failure: {
          code: "approval_reviewer_unavailable" as const,
          message: "not used",
          retryable: false,
          metadata: {},
        },
      };
    },
  };
  return {
    bindingId: "reviewer.auto.binding",
    kind: "auto_review" as const,
    reviewer,
    descriptor: {
      id: "reviewer.auto",
      kind: "auto_review" as const,
      displayName: "Automatic reviewer",
      source: "test",
      metadata: {},
    },
    reviewTimeoutMs: 1_000,
  };
}
