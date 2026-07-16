import type {
  ManagedPermissionConstraints,
} from "@agent-anything/governance";
import {
  createApprovalRequest,
  resolvePermissionProfile,
  type ApprovalReviewerPort,
  type ApprovalReviewOutcome,
  type ResolvedPermissionProfile,
  type SessionAuthorityPort,
  type SessionAuthorityRecord,
} from "@agent-anything/permission";
import type { InvocationInterruptionContext } from "@agent-anything/shared";
import { describe, expect, it } from "vitest";
import {
  deriveApprovalReviewDeadline,
  deriveAuthorityCommitDeadline,
  deriveRunDeadline,
  snapshotResolvedRunPermissionConfig,
  type ResolvedRunPermissionConfig,
} from "./RunPermissionConfig.js";
import {
  assertRunPermissionStateInvariant,
  createInitialRunPermissionState,
  projectPermissionContext,
  type PendingApproval,
} from "./RunPermissionState.js";
import {
  createApprovalRecordSummary,
  createApprovalRequestSummary,
} from "./ApprovalSummary.js";

describe("Run permission configuration", () => {
  it("snapshots one explicit immutable configuration and derives bounded deadlines", () => {
    const rulePattern = ["pnpm", "test"] as [string, ...string[]];
    const config = createPermissionConfig({
      rules: [{
        id: "rule.test",
        commandPattern: rulePattern,
        cwd: "/work/repo",
        decision: "prompt",
        source: "test",
        justification: null,
      }],
      networkRules: [],
    });

    const snapshot = snapshotResolvedRunPermissionConfig({
      permissions: config,
      workspace: workspace(),
      identity: identity(),
    });
    rulePattern[0] = "changed";

    expect(snapshot.rules[0]?.commandPattern).toEqual(["pnpm", "test"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.permissionProfile.fileSystem.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.managedConstraints.network)).toBe(true);
    expect(deriveRunDeadline("2026-07-15T00:00:00.000Z", 10_000)).toBe(
      "2026-07-15T00:00:10.000Z",
    );
    expect(deriveApprovalReviewDeadline({
      runDeadlineAt: "2026-07-15T00:00:10.000Z",
      reviewStartedAt: "2026-07-15T00:00:02.000Z",
      reviewTimeoutMs: 3_000,
    })).toBe("2026-07-15T00:00:05.000Z");
    expect(deriveApprovalReviewDeadline({
      runDeadlineAt: "2026-07-15T00:00:10.000Z",
      reviewStartedAt: "2026-07-15T00:00:09.000Z",
      reviewTimeoutMs: 5_000,
    })).toBe("2026-07-15T00:00:10.000Z");
    expect(deriveAuthorityCommitDeadline({
      runDeadlineAt: "2026-07-15T00:00:10.000Z",
      commitStartedAt: "2026-07-15T00:00:09.000Z",
      commitTimeoutMs: 5_000,
    })).toBe("2026-07-15T00:00:10.000Z");
  });

  it("requires exactly one reachable reviewer binding", () => {
    expect(() => snapshotResolvedRunPermissionConfig({
      permissions: createPermissionConfig({ approvalPolicy: "on-request" }),
      workspace: workspace(),
      identity: identity(),
    })).toThrow("requires a reviewer binding");

    expect(() => snapshotResolvedRunPermissionConfig({
      permissions: createPermissionConfig({
        approvalPolicy: "never",
        reviewer: reviewerBinding("user", null),
      }),
      workspace: workspace(),
      identity: identity(),
    })).toThrow("must not carry a reviewer binding");

    expect(() => snapshotResolvedRunPermissionConfig({
      permissions: createPermissionConfig({
        approvalPolicy: "on-request",
        reviewer: reviewerBinding("auto_review", null),
      }),
      workspace: workspace(),
      identity: identity(),
    })).toThrow("automatic reviewer requires a finite timeout");
  });

  it("rejects mismatched managed constraint snapshots", () => {
    expect(() => snapshotResolvedRunPermissionConfig({
      permissions: {
        ...createPermissionConfig(),
        managedConstraints: {
          ...managedConstraints(),
          constraintSetId: "different",
        },
      },
      workspace: workspace(),
      identity: identity(),
    })).toThrow("same constraint set");
  });

  it("rejects resolved profiles and rules that still contain non-canonical paths", () => {
    const config = createPermissionConfig();
    expect(() => snapshotResolvedRunPermissionConfig({
      permissions: {
        ...config,
        permissionProfile: {
          ...config.permissionProfile,
          workspaceRoots: [{ rootId: "repo", canonicalPath: "/work/./repo" }],
        },
      },
      workspace: workspace(),
      identity: identity(),
    })).toThrow("must already be canonical");

    expect(() => snapshotResolvedRunPermissionConfig({
      permissions: createPermissionConfig({
        rules: [{
          id: "rule.noncanonical-cwd",
          commandPattern: ["pnpm", "test"],
          cwd: "/work/repo/../repo",
          decision: "prompt",
          source: "test",
          justification: null,
        }],
        networkRules: [],
      }),
      workspace: workspace(),
      identity: identity(),
    })).toThrow("cwd must already be canonical");
  });

  it("validates and restores only exact initial Session authority records", () => {
    const context = {
      hostSessionId: "session.test",
      authorityContextKey: "authority-context.test",
      workspaceId: "workspace.test",
      identityId: "identity.test",
      environmentId: "local",
    };
    const record: SessionAuthorityRecord = {
      id: "session-authority.test",
      ...context,
      category: "permissions",
      applicabilityKeys: [{
        category: "permissions",
        value: "permissions.write-output",
      }],
      grantedPermissions: {
        fileSystem: { write: ["/work/repo/output.txt"] },
      },
      sourceRequestId: "request.test",
      sourceActionFingerprint: "fingerprint.test",
      createdAt: "2026-07-15T00:00:00.000Z",
    };
    const sessionAuthority = {
      context,
      initialRecords: [record],
      port: sessionAuthorityPort(),
    };
    const config = snapshotResolvedRunPermissionConfig({
      permissions: createPermissionConfig({ sessionAuthority }),
      workspace: workspace(),
      identity: identity(),
    });

    const state = createInitialRunPermissionState(config);
    expect(projectPermissionContext(config, state).authority).toMatchObject({
      hasAdditionalFileSystemWrite: true,
      sessionAuthorityCount: 1,
    });
    expect(Object.isFrozen(state.sessionAuthorityRecords[0])).toBe(true);

    expect(() => snapshotResolvedRunPermissionConfig({
      permissions: createPermissionConfig({
        sessionAuthority: {
          ...sessionAuthority,
          initialRecords: [{ ...record, workspaceId: "workspace.other" }],
        },
      }),
      workspace: workspace(),
      identity: identity(),
    })).toThrow("does not match the active authority context");
  });
});

describe("Run permission state", () => {
  it("starts without pending authority and projects only safe capability summaries", () => {
    const config = snapshotResolvedRunPermissionConfig({
      permissions: createPermissionConfig(),
      workspace: workspace(),
      identity: identity(),
    });
    const state = createInitialRunPermissionState(config);
    const projection = projectPermissionContext(config, state);

    assertRunPermissionStateInvariant(state, "running");
    expect(projection).toMatchObject({
      profile: {
        profileId: ":read-only",
        canRequestAdditionalPermissions: false,
      },
      authority: {
        runGrantCount: 0,
        sessionAuthorityCount: 0,
      },
      approval: {
        canRequest: false,
        reviewer: null,
        pending: false,
        requestsRemaining: 8,
      },
    });
    expect(JSON.stringify(projection)).not.toContain("/work/repo");
    expect(Object.isFrozen(projection.authority)).toBe(true);
  });

  it("creates detached safe request and resolution summaries", () => {
    const request = approvalRequest();
    const requestSummary = createApprovalRequestSummary(request);
    const recordSummary = createApprovalRecordSummary({
      id: "approval.record.1",
      runId: request.runId,
      requestId: request.id,
      actionId: request.actionId,
      actionFingerprint: request.actionFingerprint,
      pendingVersion: 1,
      reviewer: "user",
      resolution: {
        kind: "decision",
        decision: { kind: "decline", reason: "Not now" },
      },
      application: { kind: "not_applicable" },
      resolvedAt: "2026-07-15T00:00:01.000Z",
      metadata: { private: true },
    });

    expect(requestSummary).toMatchObject({
      requestId: request.id,
      optionIds: ["accept.action"],
    });
    expect(recordSummary).toMatchObject({
      recordId: "approval.record.1",
      resolutionKind: "decision",
      decisionKind: "decline",
      applicationKind: "not_applicable",
      code: null,
    });
    expect(JSON.stringify(recordSummary)).not.toContain("private");
    expect(requestSummary).not.toBe(request);
    expect(Object.isFrozen(requestSummary.optionIds)).toBe(true);
  });

  it("allows PendingApproval only with waiting_for_approval", () => {
    const config = createPermissionConfig({
      approvalPolicy: "on-request",
      reviewer: reviewerBinding("user", null),
    });
    const state = createInitialRunPermissionState(config);
    const pending: PendingApproval = {
      phase: "reviewing",
      request: approvalRequest(),
      reviewerBindingId: "reviewer.user",
      reviewer: "user",
      reviewOperationId: "review.operation.1",
      version: 1,
      createdAt: "2026-07-15T00:00:00.000Z",
    };
    const waiting = {
      ...state,
      pendingApproval: pending,
      counters: { ...state.counters, lastPendingVersion: 1 },
    };

    expect(() => assertRunPermissionStateInvariant(
      waiting,
      "waiting_for_approval",
    )).not.toThrow();
    expect(() => assertRunPermissionStateInvariant(waiting, "running")).toThrow(
      "cannot retain PendingApproval",
    );
    expect(() => assertRunPermissionStateInvariant(state, "waiting_for_approval"))
      .toThrow("requires exactly one PendingApproval");

    expect(() => assertRunPermissionStateInvariant({
      ...waiting,
      pendingApproval: {
        ...pending,
        request: { ...pending.request, decisionOptions: [] },
      } as PendingApproval,
    }, "waiting_for_approval")).toThrow("at least one decision option");

    expect(() => assertRunPermissionStateInvariant({
      ...waiting,
      counters: { ...waiting.counters, lastPendingVersion: 2 },
    }, "waiting_for_approval")).toThrow("must equal ApprovalCounters.lastPendingVersion");
  });
});

function createPermissionConfig(
  overrides: Partial<ResolvedRunPermissionConfig> = {},
): ResolvedRunPermissionConfig {
  const constraints = managedConstraints();
  return {
    permissionProfile: profile(constraints),
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
    ...overrides,
  };
}

function profile(
  constraints: ManagedPermissionConstraints,
): ResolvedPermissionProfile {
  return resolvePermissionProfile({
    profileId: ":read-only",
    profiles: [],
    environment: {
      environmentId: "local",
      platform: "posix",
      workspaceRoots: [{ rootId: "repo", path: "/work/repo" }],
    },
    managedConstraints: constraints,
  });
}

function managedConstraints(): ManagedPermissionConstraints {
  return {
    constraintSetId: "managed.test",
    selectableProfiles: { allowedProfileIds: null, deniedProfileIds: [] },
    fileSystem: [],
    network: { enabled: null, allowedDomains: [], deniedDomains: [] },
    allowUnenforcedExecution: false,
  };
}

function workspace() {
  return {
    id: "workspace.test",
    name: "Test workspace",
    rootRef: "/work/repo",
    trustState: "trusted" as const,
    source: "test",
    policyRefs: [],
    metadata: {},
  };
}

function identity() {
  return {
    id: "identity.test",
    kind: "user" as const,
    displayName: "Test user",
    metadata: {},
  };
}

function reviewerBinding(
  kind: "user" | "auto_review",
  reviewTimeoutMs: number | null,
) {
  const reviewer: ApprovalReviewerPort = {
    async review(
      _input,
      _context: InvocationInterruptionContext,
    ): Promise<ApprovalReviewOutcome> {
      return {
        status: "failed",
        failure: {
          code: "approval_reviewer_unavailable",
          message: "Test reviewer is not invoked in Slice4.",
          retryable: false,
          metadata: {},
        },
      };
    },
  };
  return {
    bindingId: `reviewer.${kind}`,
    kind,
    reviewer,
    descriptor: {
      id: `reviewer.${kind}`,
      kind,
      displayName: "Test reviewer",
      source: "test",
      metadata: {},
    },
    reviewTimeoutMs,
  };
}

function sessionAuthorityPort(): SessionAuthorityPort {
  return {
    async listApplicable() {
      return [];
    },
    async commit(input) {
      return { kind: "applied", record: input.record };
    },
  };
}

function approvalRequest() {
  return createApprovalRequest({
    id: "approval.request.1",
    createdAt: "2026-07-15T00:00:00.000Z",
    requirement: {
      category: "mcpToolCall",
      subject: {
        runId: "run.test",
        actionId: "action.test",
        actionFingerprint: "sha256:test",
        environmentId: "local",
        applicabilityKeys: [],
      },
      reason: "Review MCP tool call.",
      payload: {
        serverId: "server.test",
        serverDisplayName: "Test server",
        toolName: "read",
        safeArguments: {},
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
        trustedProposalRef: null,
        metadata: {},
      }],
      trustedProposals: [],
      deadlineAt: "2026-07-15T00:01:00.000Z",
      metadata: {},
    },
  });
}
