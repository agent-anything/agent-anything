import {
  createInMemoryHostPolicyAmendmentStore,
  createInMemoryHostSessionAuthorityStore,
} from "@agent-anything/host/authority";
import type { ApprovalReviewerPort, SessionAuthorityPort } from "@agent-anything/permission";
import { describe, expect, it } from "vitest";
import { createHelarcHostPermissionComposition } from "./HelarcHostPermissionComposition.js";

describe("Helarc Host permission composition", () => {
  it("binds Ask for approval to a descriptor-only Run-scoped user reviewer", async () => {
    const composition = await createHelarcHostPermissionComposition({
      ...baseInput(),
      preset: "ask_for_approval",
    });

    expect(composition.permissions).toMatchObject({
      permissionProfile: {
        id: "helarc-workspace-disabled",
        enforcement: "disabled",
        process: { unrestricted: false },
      },
      approvalPolicy: "on-request",
      reviewer: {
        kind: "user",
        bindingId: "run.1:reviewer:user",
        descriptor: {
          id: "helarc-desktop-user-reviewer",
          source: "helarc-desktop",
        },
      },
    });
    expect(composition.permissions.reviewer).not.toHaveProperty("reviewer");
  });

  it("requires exactly the automatic reviewer selected by each preset", async () => {
    await expect(createHelarcHostPermissionComposition({
      ...baseInput(),
      preset: "ask_for_approval",
      automaticReviewer: autoReviewer(),
    })).rejects.toThrow("must not include an automatic reviewer");
    await expect(createHelarcHostPermissionComposition({
      ...baseInput(),
      preset: "approve_for_me",
    })).rejects.toThrow("requires an explicit automatic reviewer");
    await expect(createHelarcHostPermissionComposition({
      ...baseInput(),
      preset: "full_access",
      automaticReviewer: autoReviewer(),
    })).rejects.toThrow("must not include an approval reviewer");
  });

  it("binds Approve for me and Full access without a user transport bridge", async () => {
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
      sessionAuthorityPort: unavailable,
    })).rejects.toThrow("authority store unavailable");
  });
});

function baseInput() {
  return {
    productRunId: "run.1",
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
    automaticReviewer: null,
    sessionAuthorityPort: createInMemoryHostSessionAuthorityStore({ maxRecords: 64 }),
    persistentPolicyAmendments: createInMemoryHostPolicyAmendmentStore({ maxRecords: 64 }),
  };
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
