import type { ManagedPermissionConstraints } from "@agent-anything/governance";
import type {
  ApprovalReviewerPort,
  SessionAuthorityContext,
  SessionAuthorityPort,
  SessionAuthorityRecord,
} from "@agent-anything/permission";
import type { InvocationInterruptionContext } from "@agent-anything/shared";
import { describe, expect, it } from "vitest";
import { resolveHostRunPermissionConfig } from "./HostRunPermissionComposition.js";

describe("resolveHostRunPermissionConfig", () => {
  it("resolves an explicit composition and loads the exact Session context", async () => {
    const record = sessionRecord();
    const queries: unknown[] = [];
    const port: SessionAuthorityPort = {
      async listApplicable(query) {
        queries.push(query);
        return [record];
      },
      async commit() {
        return { kind: "applied", record };
      },
    };

    const config = await resolveHostRunPermissionConfig({
      ...baseInput(),
      sessionAuthority: {
        context: sessionContext(),
        port,
        maxInitialRecords: 4,
      },
    });

    expect(config.permissionProfile.id).toBe(":workspace");
    expect(config.sessionAuthority?.initialRecords).toEqual([record]);
    expect(queries).toEqual([{
      context: sessionContext(),
      category: null,
      applicabilityKeys: [],
    }]);
    expect(Object.isFrozen(config.sessionAuthority?.initialRecords)).toBe(true);
  });

  it("rejects a review-capable policy without an explicit reviewer", async () => {
    await expect(resolveHostRunPermissionConfig({
      ...baseInput(),
      reviewer: null,
    })).rejects.toThrow("requires an explicit reviewer binding");
  });

  it("rejects Session authority above the configured pre-Run limit", async () => {
    const record = sessionRecord();
    await expect(resolveHostRunPermissionConfig({
      ...baseInput(),
      sessionAuthority: {
        context: sessionContext(),
        port: {
          async listApplicable() {
            return [record, { ...record, id: "authority.2" }];
          },
          async commit() {
            return { kind: "applied", record };
          },
        },
        maxInitialRecords: 1,
      },
    })).rejects.toThrow("configured limit is 1");
  });
});

function baseInput() {
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
    profile: {
      profileId: ":workspace",
      profiles: [],
      environment: {
        environmentId: "local",
        platform: "win32" as const,
        workspaceRoots: [{ rootId: "root", path: "D:\\workspace" }],
      },
    },
    approvalPolicy: "on-request" as const,
    reviewer: {
      bindingId: "reviewer.binding",
      kind: "user" as const,
      reviewer,
      descriptor: {
        id: "reviewer.user",
        kind: "user" as const,
        displayName: "User",
        source: "host",
        metadata: {},
      },
      reviewTimeoutMs: null,
    },
    rules: [],
    managedConstraints: managedConstraints(),
    sessionAuthority: null,
    persistentPolicyAmendments: null,
    approvalLimits: {
      maxRequestsPerRun: 8,
      maxRequestsPerActionFingerprint: 2,
      maxConsecutiveDeclines: 3,
      maxConsecutiveReviewFailures: 3,
    },
    authorityApplicationLimits: { commitTimeoutMs: 5_000 },
    interruption: interruptionContext(),
  };
}

function managedConstraints(): ManagedPermissionConstraints {
  return {
    constraintSetId: "local-default",
    selectableProfiles: { allowedProfileIds: null, deniedProfileIds: [] },
    fileSystem: [],
    network: { enabled: null, allowedDomains: [], deniedDomains: [] },
    allowUnenforcedExecution: false,
  };
}

function sessionContext(): SessionAuthorityContext {
  return {
    hostSessionId: "session.1",
    authorityContextKey: "context.1",
    workspaceId: "workspace.1",
    identityId: null,
    environmentId: "local",
  };
}

function sessionRecord(): SessionAuthorityRecord {
  return {
    id: "authority.1",
    ...sessionContext(),
    category: "permissions",
    applicabilityKeys: [{ category: "permissions", value: "scope.1" }],
    grantedPermissions: null,
    sourceRequestId: "request.1",
    sourceActionFingerprint: "sha256:action.1",
    createdAt: "2026-07-15T00:00:00.000Z",
  };
}

function interruptionContext(): InvocationInterruptionContext {
  return Object.freeze({ signal: new AbortController().signal, interruption: null });
}
