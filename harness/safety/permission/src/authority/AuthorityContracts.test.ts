import type { ManagedPermissionConstraints } from "@agent-anything/governance/managed-permission";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { describe, expect, it } from "vitest";
import { canonicalizeAdditionalPermissions } from "../approval/PermissionDelta.js";
import { resolvePermissionProfile } from "../profile/resolvePermissionProfile.js";
import { allowsRetainedFileRead } from "./ActionPermissionAssessment.js";
import {
  createActionApprovalCoverage,
  type SessionAuthorizationCommit,
  type SessionAuthorizationCommitResult,
  type SessionAuthorizationLookup,
  type SessionAuthorizationStore,
  type SessionAuthorizationBasis,
  type SessionAuthorizationBasisInput,
  type ValidatedActionAuthorizationBasis,
} from "./AuthorityContracts.js";
import {
  isActionApprovalCoverageApplicable,
  isSessionAuthorizationApplicable,
  validateSessionAuthorizationBasis,
} from "./validateAuthority.js";

describe("authority contracts", () => {
  it("checks retained file reads against current path grants rather than historical approval", () => {
    const resolved = resolvePermissionProfile({profileId: ":workspace", profiles: [], environment: environment(), managedConstraints: noManagedConstraints()});
    const profile = {...resolved, fileSystem: {...resolved.fileSystem, unrestricted: false, entries: []}};
    const path = "/work/repo/src/file.ts";
    expect(allowsRetainedFileRead({profile, path, grants: []})).toBe(false);
    expect(allowsRetainedFileRead({profile, path, grants: [{fileSystem: {read: ["/work/repo/src"]}}]})).toBe(true);
    expect(allowsRetainedFileRead({profile, path, grants: [{fileSystem: {write: ["/work/repo/src"]}}]})).toBe(true);
    expect(allowsRetainedFileRead({profile, path, grants: [{fileSystem: {read: ["/work/repo/src-other"]}}]})).toBe(false);
  });
  it("does not let a retained read grant cross a current managed denial", () => {
    const profile = resolvePermissionProfile({profileId: ":workspace", profiles: [], environment: environment(),
      managedConstraints: {...noManagedConstraints(), fileSystem: [{target: {kind: "workspace_path", rootId: "repo", path: "private"}, maximumAccess: "none"}]}});
    expect(allowsRetainedFileRead({profile, path: "/work/repo/private/key.txt", grants: [{fileSystem: {read: ["/work/repo"]}}]})).toBe(false);
    expect(allowsRetainedFileRead({profile, path: "/work/repo/public.txt", grants: []})).toBe(true);
  });
  it("loads all records for an exact Session context when category is null", () => {
    const record = validatedRecord();
    expect(isSessionAuthorizationApplicable(record, {
      context: sessionContext(),
      category: null,
      applicabilityKeys: [],
    })).toBe(true);
  });
  it("creates exact consumable Action coverage", () => {
    const authority: ValidatedActionAuthorizationBasis = {
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
    const result = validateSessionAuthorizationBasis({
      record: sessionRecordInput(),
      expectedContext: sessionContext(),
      cwd: "/work/repo",
      environment: environment(),
      managedConstraints: noManagedConstraints(),
    });

    expect(result).toMatchObject({ status: "valid" });
    if (result.status === "valid") {
      expect(
        isSessionAuthorizationApplicable(result.record, {
          context: sessionContext(),
          category: "commandExecution",
          applicabilityKeys: [
            { category: "commandExecution", value: "command:pnpm-test" },
          ],
        }),
      ).toBe(true);
      expect(
        isSessionAuthorizationApplicable(result.record, {
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
      validateSessionAuthorizationBasis({
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
      validateSessionAuthorizationBasis({
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
    const result = validateSessionAuthorizationBasis({
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

class FakeSessionAuthorityPort implements SessionAuthorizationStore {
  readonly commits: SessionAuthorizationCommit[] = [];

  constructor(private readonly result: SessionAuthorizationCommitResult) {}

  async listApplicable(
    _input: SessionAuthorizationLookup,
    _context: InvocationInterruptionContext,
  ): Promise<readonly SessionAuthorizationBasis[]> {
    return [];
  }

  async commit(
    input: SessionAuthorizationCommit,
    _context: InvocationInterruptionContext,
  ): Promise<SessionAuthorizationCommitResult> {
    this.commits.push(input);
    return this.result;
  }
}

function sessionRecordInput(): SessionAuthorizationBasisInput {
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

function validatedRecord(): SessionAuthorizationBasis {
  const result = validateSessionAuthorizationBasis({
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
