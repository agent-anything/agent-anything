import type { ManagedPermissionConstraints } from "@agent-anything/governance/managed-permission";
import { describe, expect, it } from "vitest";
import type { ApprovalRequirement, ApprovalRequest } from "./ApprovalContracts.js";
import { canonicalizeAdditionalPermissions } from "./PermissionDelta.js";
import { createApprovalRequest } from "./createApprovalRequest.js";
import {
  validateApprovalDecision,
  type ValidateApprovalDecisionInput,
} from "./validateApprovalDecision.js";

describe("approval decision validation", () => {
  it("creates a branded Run grant only for a requested subset", () => {
    const input = decisionInput("grant_run", {
      fileSystem: { read: ["/work/repo/src"] },
      network: { enabled: true, domains: ["api.example.com"] },
    });
    const result = validateApprovalDecision(input);

    expect(result).toMatchObject({
      status: "valid",
      decision: {
        kind: "grantPermissions",
        authority: {
          scope: "run",
          grant: { id: "run_grant_1", runId: "run_1" },
        },
      },
    });
    if (result.status === "valid") expect(Object.isFrozen(result.decision)).toBe(true);
  });

  it("rejects stale correlation and broadened permissions as non-authoritative", () => {
    expect(
      validateApprovalDecision({
        ...decisionInput("grant_run", {
          fileSystem: { read: ["/work/repo/src"] },
        }),
        pendingVersion: 2,
      }),
    ).toMatchObject({ status: "invalid", code: "approval_version_mismatch" });

    expect(
      validateApprovalDecision(
        decisionInput("grant_run", {
          fileSystem: { write: ["/work"] },
        }),
      ),
    ).toMatchObject({
      status: "invalid",
      code: "permissions_write_not_requested",
    });
  });

  it("creates Session authority only from the trusted proposal", () => {
    const result = validateApprovalDecision(
      decisionInput("grant_session", {
        fileSystem: { read: ["/work/repo/src"] },
      }),
    );

    expect(result).toMatchObject({
      status: "valid",
      decision: {
        kind: "grantPermissions",
        authority: {
          scope: "session",
          record: {
            id: "session_authority_1",
            hostSessionId: "session_1",
            authorityContextKey: "context_1",
            applicabilityKeys: [
              { category: "commandExecution", value: "command:pnpm-test" },
            ],
          },
        },
      },
    });
  });

  it("selects a trusted amendment without accepting renderer mutation data", () => {
    const result = validateApprovalDecision(decisionInput("exec_amendment", null));

    expect(result).toMatchObject({
      status: "valid",
      decision: {
        kind: "acceptWithExecpolicyAmendment",
        trustedProposalRef: "proposal_exec_1",
        amendment: {
          commandPattern: ["pnpm", "test"],
          sourceFingerprint: "sha256:command",
        },
      },
    });
  });

  it("creates exact Action authority and rejects grants on non-grant options", () => {
    const accepted = validateApprovalDecision(decisionInput("accept_action", null));
    expect(accepted).toMatchObject({
      status: "valid",
      decision: {
        kind: "accept",
        actionAuthority: {
          actionId: "action_1",
          actionFingerprint: "sha256:command",
        },
      },
    });

    expect(
      validateApprovalDecision(
        decisionInput("decline", { fileSystem: { read: ["src"] } }),
      ),
    ).toMatchObject({ status: "invalid", code: "approval_option_unsupported" });
  });

  it("rejects a managed deny even when the grant is inside the request", () => {
    const input = decisionInput("grant_run", {
      fileSystem: { write: ["/work/repo/secrets"] },
    });
    const constrained: ValidateApprovalDecisionInput = {
      ...input,
      managedConstraints: {
        ...noManagedConstraints(),
        fileSystem: [
          {
            target: {
              kind: "workspace_path",
              rootId: "repo",
              path: "secrets",
            },
            maximumAccess: "none",
          },
        ],
      },
    };

    expect(validateApprovalDecision(constrained)).toMatchObject({
      status: "invalid",
      code: "permissions_managed_filesystem_denied",
    });
  });
});

function decisionInput(
  optionId: string,
  grantedPermissions: ValidateApprovalDecisionInput["submission"]["grantedPermissions"],
): ValidateApprovalDecisionInput {
  return {
    request: commandRequest(),
    pendingVersion: 1,
    submission: {
      submissionId: `submission_${optionId}`,
      runId: "run_1",
      requestId: "request_1",
      pendingVersion: 1,
      optionId,
      grantedPermissions,
      reason: optionId === "decline" ? "Denied." : null,
    },
    cwd: "/work/repo",
    environment: portableEnvironment(),
    managedConstraints: noManagedConstraints(),
    identities: {
      actionAuthorityId: "action_authority_1",
      runPermissionGrantId: "run_grant_1",
      sessionAuthorityRecordId: "session_authority_1",
    },
    validatedAt: "2026-07-15T00:01:00.000Z",
  };
}

function commandRequest(): ApprovalRequest {
  const permissions = canonicalizeAdditionalPermissions({
    permissions: {
      fileSystem: { read: ["src"], write: ["/work/repo"] },
      network: { enabled: true, domains: ["*.example.com"] },
    },
    cwd: "/work/repo",
    environment: portableEnvironment(),
  });
  if (permissions.status === "invalid") throw new Error(permissions.message);

  const requirement: ApprovalRequirement<"commandExecution"> = {
    category: "commandExecution",
    subject: {
      runId: "run_1",
      actionId: "action_1",
      actionFingerprint: "sha256:command",
      environmentId: "portable",
      applicabilityKeys: [
        { category: "commandExecution", value: "command:pnpm-test" },
      ],
    },
    reason: "Run tests.",
    payload: {
      command: ["pnpm", "test"],
      safeCommandDisplay: "pnpm test",
      cwd: "/work/repo",
      cwdDisplay: "workspace",
      environmentId: "portable",
      commandActions: [{ kind: "process", summary: "Run tests" }],
      additionalPermissions: permissions.permissions,
    },
    decisionOptions: [
      option("accept_action", "accept", "action", null),
      option("accept_session", "acceptForSession", "session", "proposal_session_1"),
      option("grant_run", "grantPermissions", "run", null),
      option("grant_session", "grantPermissions", "session", "proposal_session_1"),
      option("exec_amendment", "acceptWithExecpolicyAmendment", "persistent", "proposal_exec_1"),
      option("network_amendment", "applyNetworkPolicyAmendment", "persistent", "proposal_network_1"),
      option("decline", "decline", null, null),
      option("cancel", "cancel", null, null),
    ],
    trustedProposals: [
      {
        kind: "session_authority",
        ref: "proposal_session_1",
        proposal: {
          proposalRef: "proposal_session_1",
          context: {
            hostSessionId: "session_1",
            authorityContextKey: "context_1",
            workspaceId: "workspace_1",
            identityId: "identity_1",
            environmentId: "portable",
          },
          category: "commandExecution",
          applicabilityKeys: [
            { category: "commandExecution", value: "command:pnpm-test" },
          ],
          defaultGrantedPermissions: null,
        },
      },
      {
        kind: "exec_policy_amendment",
        ref: "proposal_exec_1",
        amendment: {
          amendmentId: "amendment.exec.1",
          environmentId: "portable",
          commandPattern: ["pnpm", "test"],
          cwd: "/work/repo",
          effect: "allow",
          sourceFingerprint: "sha256:command",
        },
      },
      {
        kind: "network_policy_amendment",
        ref: "proposal_network_1",
        amendment: {
          amendmentId: "amendment.network.1",
          environmentId: "portable",
          hostPattern: "*.example.com",
          ports: [443],
          protocols: ["https"],
          effect: "allow",
          sourceFingerprint: "sha256:command",
        },
      },
    ],
    deadlineAt: "2026-07-15T00:05:00.000Z",
    metadata: {},
  };
  return createApprovalRequest({
    id: "request_1",
    requirement,
    createdAt: "2026-07-15T00:00:00.000Z",
  });
}

function option(
  id: string,
  kind: ApprovalRequirement<"commandExecution">["decisionOptions"][number]["kind"],
  scope: "action" | "run" | "session" | "persistent" | null,
  trustedProposalRef: string | null,
) {
  return {
    id,
    kind,
    scope,
    label: id,
    description: null,
    trustedProposalRef,
    metadata: {},
  };
}

function portableEnvironment() {
  return {
    environmentId: "portable",
    platform: "posix" as const,
    workspaceRoots: [{ rootId: "repo", path: "/work/repo" }],
  };
}

function noManagedConstraints(): ManagedPermissionConstraints {
  return {
    constraintSetId: "none",
    selectableProfiles: { allowedProfileIds: null, deniedProfileIds: [] },
    fileSystem: [],
    network: { enabled: null, allowedDomains: [], deniedDomains: [] },
    allowUnenforcedExecution: true,
  };
}
