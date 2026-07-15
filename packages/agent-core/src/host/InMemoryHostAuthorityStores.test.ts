import type {
  PersistentPolicyAmendmentCommit,
} from "@agent-anything/governance";
import type {
  SessionAuthorityCommit,
  SessionAuthorityContext,
  SessionAuthorityRecord,
} from "@agent-anything/permission";
import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
} from "@agent-anything/shared";
import { describe, expect, it } from "vitest";
import { createInMemoryHostPolicyAmendmentStore } from "./InMemoryHostPolicyAmendmentStore.js";
import { createInMemoryHostSessionAuthorityStore } from "./InMemoryHostSessionAuthorityStore.js";

describe("in-memory Host authority stores", () => {
  it("loads every record for a Session context and filters concrete lookups", async () => {
    const matching = sessionRecord();
    const other = sessionRecord({
      id: "authority.other",
      hostSessionId: "session.other",
    });
    const store = createInMemoryHostSessionAuthorityStore({
      maxRecords: 4,
      initialRecords: [matching, other],
    });

    await expect(store.listApplicable({
      context: sessionContext(),
      category: null,
      applicabilityKeys: [],
    }, activeContext())).resolves.toEqual([matching]);

    await expect(store.listApplicable({
      context: sessionContext(),
      category: "permissions",
      applicabilityKeys: [{ category: "permissions", value: "scope.1" }],
    }, activeContext())).resolves.toEqual([matching]);
  });

  it("makes Session commits idempotent and rejects conflicting replay", async () => {
    const store = createInMemoryHostSessionAuthorityStore({ maxRecords: 1 });
    const commit = sessionCommit();
    const first = await store.commit(commit, activeContext());

    expect(first).toMatchObject({ kind: "applied", record: { id: "authority.1" } });
    await expect(store.commit(commit, activeContext())).resolves.toBe(first);
    await expect(store.commit({
      ...commit,
      record: { ...commit.record, id: "authority.other" },
    }, activeContext())).resolves.toMatchObject({
      kind: "not_applied",
      code: "session_authority_conflict",
    });
  });

  it("normalizes, bounds, and replays persistent policy commits", async () => {
    const store = createInMemoryHostPolicyAmendmentStore({ maxRecords: 1 });
    const commit = amendmentCommit();
    const first = await store.commit(commit, activeContext());

    expect(first).toMatchObject({
      kind: "applied",
      record: { id: "amendment.record.1" },
    });
    await expect(store.commit(commit, activeContext())).resolves.toBe(first);
    await expect(store.commit({
      ...commit,
      recordId: "amendment.record.conflict",
    }, activeContext())).resolves.toMatchObject({
      kind: "not_applied",
      code: "policy_amendment_conflict",
    });
    await expect(store.commit({
      ...amendmentCommit(),
      commitId: "commit.2",
      recordId: "amendment.record.2",
    }, activeContext())).resolves.toMatchObject({
      kind: "not_applied",
      code: "policy_amendment_storage_failed",
    });
  });

  it("returns the exact attributed interruption before mutation", async () => {
    const store = createInMemoryHostSessionAuthorityStore({ maxRecords: 1 });
    const interruption: InvocationInterruptionRef = {
      kind: "run_cancellation",
      cancellation: { runId: "run.1", requestId: "cancel.1" },
    };

    await expect(store.commit(
      sessionCommit(),
      interruptedContext(interruption),
    )).resolves.toEqual({ kind: "interrupted", interruption });
    expect(store.listRecords()).toEqual([]);
  });
});

function sessionContext(): SessionAuthorityContext {
  return {
    hostSessionId: "session.1",
    authorityContextKey: "context.1",
    workspaceId: "workspace.1",
    identityId: null,
    environmentId: "local",
  };
}

function sessionRecord(
  overrides: Partial<SessionAuthorityRecord> = {},
): SessionAuthorityRecord {
  return {
    id: "authority.1",
    ...sessionContext(),
    category: "permissions",
    applicabilityKeys: [{ category: "permissions", value: "scope.1" }],
    grantedPermissions: null,
    sourceRequestId: "request.1",
    sourceActionFingerprint: "sha256:action.1",
    createdAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

function sessionCommit(): SessionAuthorityCommit {
  return { commitId: "commit.1", record: sessionRecord() };
}

function amendmentCommit(): PersistentPolicyAmendmentCommit {
  return {
    commitId: "commit.1",
    recordId: "amendment.record.1",
    proposalRef: "proposal.1",
    sourceRequestId: "request.1",
    sourceActionFingerprint: "sha256:action.1",
    amendment: {
      kind: "exec_policy",
      amendment: {
        amendmentId: "amendment.1",
        environmentId: "local",
        commandPattern: ["git", "status"],
        cwd: "D:\\workspace",
        effect: "allow",
        sourceFingerprint: "sha256:action.1",
      },
    },
    appliedAt: "2026-07-15T00:00:00.000Z",
  };
}

function activeContext(): InvocationInterruptionContext {
  return Object.freeze({ signal: new AbortController().signal, interruption: null });
}

function interruptedContext(
  interruption: InvocationInterruptionRef,
): InvocationInterruptionContext {
  const controller = new AbortController();
  controller.abort();
  return Object.freeze({ signal: controller.signal, interruption });
}
