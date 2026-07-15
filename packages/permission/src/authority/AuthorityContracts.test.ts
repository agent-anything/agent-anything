import type { ManagedPermissionConstraints } from "@agent-anything/governance/managed-permission";
import type { InvocationInterruptionContext } from "@agent-anything/shared";
import { describe, expect, it } from "vitest";
import { canonicalizeAdditionalPermissions } from "../approval/PermissionDelta.js";
import {
  createActionApprovalCoverage,
  type SessionAuthorityCommit,
  type SessionAuthorityCommitResult,
  type SessionAuthorityLookup,
  type SessionAuthorityPort,
  type SessionAuthorityRecord,
  type SessionAuthorityRecordInput,
  type ValidatedActionAuthority,
} from "./AuthorityContracts.js";
import {
  isActionApprovalCoverageApplicable,
  isSessionAuthorityApplicable,
  validateSessionAuthorityRecord,
} from "./validateAuthority.js";

describe("authority contracts", () => {
  it("creates exact consumable Action coverage", () => {
    const authority: ValidatedActionAuthority = {
      id: "coverage_1",
      runId: "run_1",
      actionId: "action_1",
      actionFingerprint: "sha256:action",
      sourceRequestId: "request_1",
      grantedPermissions: null,
      validatedAt: "2026-07-15T00:00:00.000Z",
    };
    const coverage = createActionApprovalCoverage(authority);

    expect(
      isActionApprovalCoverageApplicable(coverage, {
        runId: "run_1",
        actionId: "action_1",
        actionFingerprint: "sha256:action",
      }),
    ).toBe(true);
    expect(
      isActionApprovalCoverageApplicable(coverage, {
        runId: "run_1",
        actionId: "action_1",
        actionFingerprint: "sha256:changed",
      }),
    ).toBe(false);
    expect(Object.isFrozen(coverage)).toBe(true);
  });

  it("validates Session context, applicability, and current managed constraints", () => {
    const result = validateSessionAuthorityRecord({
      record: sessionRecordInput(),
      expectedContext: sessionContext(),
      cwd: "/work/repo",
      environment: environment(),
      managedConstraints: noManagedConstraints(),
    });

    expect(result).toMatchObject({ status: "valid" });
    if (result.status === "valid") {
      expect(
        isSessionAuthorityApplicable(result.record, {
          context: sessionContext(),
          category: "commandExecution",
          applicabilityKeys: [
            { category: "commandExecution", value: "command:pnpm-test" },
          ],
        }),
      ).toBe(true);
      expect(
        isSessionAuthorityApplicable(result.record, {
          context: sessionContext(),
          category: "commandExecution",
          applicabilityKeys: [
            { category: "commandExecution", value: "command:other" },
          ],
        }),
      ).toBe(false);
    }
  });

  it("rejects context mismatch and managed authority denial", () => {
    expect(
      validateSessionAuthorityRecord({
        record: sessionRecordInput(),
        expectedContext: { ...sessionContext(), workspaceId: "workspace_2" },
        cwd: "/work/repo",
        environment: environment(),
        managedConstraints: noManagedConstraints(),
      }),
    ).toMatchObject({
      status: "invalid",
      code: "session_authority_context_mismatch",
    });

    expect(
      validateSessionAuthorityRecord({
        record: sessionRecordInput(),
        expectedContext: sessionContext(),
        cwd: "/work/repo",
        environment: environment(),
        managedConstraints: {
          ...noManagedConstraints(),
          fileSystem: [
            {
              target: {
                kind: "workspace_path",
                rootId: "repo",
                path: "src",
              },
              maximumAccess: "none",
            },
          ],
        },
      }),
    ).toMatchObject({
      status: "invalid",
      code: "session_authority_permissions_invalid",
    });
  });

  it("rejects stored Session permissions that are not already canonical", () => {
    const result = validateSessionAuthorityRecord({
      record: {
        ...sessionRecordInput(),
        grantedPermissions: {
          fileSystem: { read: ["relative/path"] },
        },
      },
      expectedContext: sessionContext(),
      cwd: "/work/repo",
      environment: environment(),
      managedConstraints: noManagedConstraints(),
    });

    expect(result).toMatchObject({
      status: "invalid",
      code: "session_authority_permissions_invalid",
    });
  });

  it("keeps Session commit outcome certainty explicit", async () => {
    const record = validatedRecord();
    const port = new FakeSessionAuthorityPort({
      kind: "outcome_unknown",
      code: "session_authority_commit_outcome_unknown",
      message: "Commit acknowledgement was lost.",
    });
    const commit = { commitId: "commit_1", record };

    await expect(port.commit(commit, interruptionContext())).resolves.toMatchObject({
      kind: "outcome_unknown",
    });
    expect(port.commits).toEqual([commit]);
  });
});

class FakeSessionAuthorityPort implements SessionAuthorityPort {
  readonly commits: SessionAuthorityCommit[] = [];

  constructor(private readonly result: SessionAuthorityCommitResult) {}

  async listApplicable(
    _input: SessionAuthorityLookup,
    _context: InvocationInterruptionContext,
  ): Promise<readonly SessionAuthorityRecord[]> {
    return [];
  }

  async commit(
    input: SessionAuthorityCommit,
    _context: InvocationInterruptionContext,
  ): Promise<SessionAuthorityCommitResult> {
    this.commits.push(input);
    return this.result;
  }
}

function sessionRecordInput(): SessionAuthorityRecordInput {
  const permissions = canonicalizeAdditionalPermissions({
    permissions: { fileSystem: { read: ["src"] } },
    cwd: "/work/repo",
    environment: environment(),
  });
  if (permissions.status === "invalid") throw new Error(permissions.message);
  return {
    id: "session_authority_1",
    ...sessionContext(),
    category: "commandExecution",
    applicabilityKeys: [
      { category: "commandExecution", value: "command:pnpm-test" },
    ],
    grantedPermissions: permissions.permissions,
    sourceRequestId: "request_1",
    sourceActionFingerprint: "sha256:command",
    createdAt: "2026-07-15T00:00:00.000Z",
  };
}

function validatedRecord(): SessionAuthorityRecord {
  const result = validateSessionAuthorityRecord({
    record: sessionRecordInput(),
    expectedContext: sessionContext(),
    cwd: "/work/repo",
    environment: environment(),
    managedConstraints: noManagedConstraints(),
  });
  if (result.status === "invalid") throw new Error(result.message);
  return result.record;
}

function sessionContext() {
  return {
    hostSessionId: "session_1",
    authorityContextKey: "context_1",
    workspaceId: "workspace_1",
    identityId: "identity_1",
    environmentId: "portable",
  };
}

function environment() {
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

function interruptionContext(): InvocationInterruptionContext {
  return { signal: new AbortController().signal, interruption: null };
}
