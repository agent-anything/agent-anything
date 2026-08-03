import type { Evidence } from "@agent-anything/context/evidence";
import type { EvidencePersistencePort } from "@agent-anything/context/persistence";
import { describe, expect, it, vi } from "vitest";
import {
  EnterpriseEvidencePersistenceAdapter,
  type EnterpriseEvidenceCommitInput,
  type EnterpriseEvidenceCommitOutcome,
  type EnterpriseEvidenceCommitReceipt,
  type EnterpriseEvidencePersistenceClient,
  type EnterpriseEvidencePersistencePolicy,
  type EnterpriseEvidenceReconciliationInput,
  type EnterpriseEvidenceReconciliationOutcome,
} from "./EnterpriseEvidencePersistence.js";

const NOW = "2026-07-20T00:00:00.000Z";

describe("EnterpriseEvidencePersistenceAdapter", () => {
  it("implements the Context-owned port and applies trusted policy mapping", async () => {
    const client = new FakeEnterpriseEvidenceClient();
    const adapter: EvidencePersistencePort = createAdapter(client);

    const result = await adapter.persistEvidence(evidence({
      sensitivity: "restricted",
      metadata: {
        retentionPolicyRef: "caller-weak-retention",
        accessPolicyRef: "caller-public-access",
      },
    }));

    expect(client.commits).toHaveLength(1);
    expect(client.commits[0]).toMatchObject({
      commitId: "enterprise-evidence:tenant-a:evidence_1",
      workspaceId: "workspace_1",
      actorRef: "user_1",
      retentionPolicyRef: "retention-restricted",
      accessPolicyRef: "access-restricted",
      sensitivity: "restricted",
      auditCorrelationId: "audit_1",
    });
    expect(Object.isFrozen(client.commits[0]!.evidence)).toBe(true);
    expect(result).toMatchObject({
      status: "stored",
      artifact: {
        storageId: "storage_evidence_1",
        evidenceRef: "evidence_1",
        artifactRef: "enterprise://evidence/evidence_1",
        metadata: {
          adapter: "enterprise-evidence",
          retentionPolicyRef: "retention-restricted",
          accessPolicyRef: "access-restricted",
          sensitivity: "restricted",
        },
      },
    });
  });

  it("reconciles an ambiguous commit before reporting durable success", async () => {
    const client = new FakeEnterpriseEvidenceClient({
      commit: async () => ({
        status: "ambiguous",
        reconciliationToken: "operation_1",
        failure: failure("enterprise_timeout", "Commit timed out.", true),
      }),
      reconcile: async (input) => ({
        status: "committed",
        receipt: receiptFromReconciliation(input),
      }),
    });
    const adapter = createAdapter(client);

    await expect(adapter.persistEvidence(evidence())).resolves.toMatchObject({
      status: "stored",
    });
    expect(client.commits).toHaveLength(1);
    expect(client.reconciliations).toEqual([{
      commitId: "enterprise-evidence:tenant-a:evidence_1",
      evidenceRef: "evidence_1",
      reconciliationToken: "operation_1",
    }]);
  });

  it("continues reconciliation on a later call without replaying an unresolved write", async () => {
    let reconciliationAttempt = 0;
    const client = new FakeEnterpriseEvidenceClient({
      commit: async () => ({
        status: "ambiguous",
        reconciliationToken: "operation_1",
        failure: failure("enterprise_timeout", "Commit timed out.", true),
      }),
      reconcile: async (input) => {
        reconciliationAttempt += 1;
        return reconciliationAttempt === 1
          ? {
              status: "unresolved",
              reconciliationToken: "operation_2",
              failure: failure(
                "enterprise_reconciliation_pending",
                "Commit settlement is still pending.",
                true,
              ),
            }
          : {
              status: "committed",
              receipt: receiptFromReconciliation(input),
            };
      },
    });
    const adapter = createAdapter(client);

    await expect(adapter.persistEvidence(evidence())).resolves.toMatchObject({
      status: "failed",
      error: { code: "enterprise_reconciliation_pending", retryable: true },
    });
    await expect(adapter.persistEvidence(evidence())).resolves.toMatchObject({
      status: "stored",
    });

    expect(client.commits).toHaveLength(1);
    expect(client.reconciliations).toHaveLength(2);
    expect(client.reconciliations[1]!.reconciliationToken).toBe("operation_2");
  });

  it("allows a new idempotent commit only after confirmed not-committed settlement", async () => {
    let commitAttempt = 0;
    const client = new FakeEnterpriseEvidenceClient({
      commit: async (input) => {
        commitAttempt += 1;
        return commitAttempt === 1
          ? {
              status: "not_committed",
              failure: failure(
                "enterprise_unavailable",
                "Storage is unavailable.",
                true,
              ),
            }
          : { status: "committed", receipt: receipt(input) };
      },
    });
    const adapter = createAdapter(client);

    await expect(adapter.persistEvidence(evidence())).resolves.toMatchObject({
      status: "failed",
      error: { code: "enterprise_unavailable", retryable: true },
    });
    await expect(adapter.persistEvidence(evidence())).resolves.toMatchObject({
      status: "stored",
    });

    expect(client.commits).toHaveLength(2);
    expect(client.commits[0]!.commitId).toBe(client.commits[1]!.commitId);
    expect(client.reconciliations).toHaveLength(0);
  });

  it("fails closed on an uncorrelated receipt and reconciles before another commit", async () => {
    let reconciliationAttempt = 0;
    const client = new FakeEnterpriseEvidenceClient({
      commit: async (input) => ({
        status: "committed",
        receipt: {
          ...receipt(input),
          evidenceRef: "different_evidence",
        },
      }),
      reconcile: async (input) => {
        reconciliationAttempt += 1;
        return {
          status: "unresolved",
          reconciliationToken: input.reconciliationToken,
          failure: failure(
            "enterprise_receipt_unresolved",
            "Stored receipt remains uncorrelated.",
            false,
          ),
        };
      },
    });
    const adapter = createAdapter(client);

    await expect(adapter.persistEvidence(evidence())).resolves.toMatchObject({
      status: "failed",
      error: { code: "enterprise_evidence_receipt_invalid" },
    });
    await expect(adapter.persistEvidence(evidence())).resolves.toMatchObject({
      status: "failed",
      error: { code: "enterprise_receipt_unresolved" },
    });

    expect(client.commits).toHaveLength(1);
    expect(reconciliationAttempt).toBe(1);
  });

  it("rejects changed content for an identity with unresolved settlement", async () => {
    const client = new FakeEnterpriseEvidenceClient({
      commit: async () => ({
        status: "ambiguous",
        reconciliationToken: null,
        failure: failure("enterprise_timeout", "Commit timed out.", true),
      }),
      reconcile: async () => ({
        status: "unresolved",
        reconciliationToken: null,
        failure: failure(
          "enterprise_reconciliation_pending",
          "Commit settlement is still pending.",
          true,
        ),
      }),
    });
    const adapter = createAdapter(client);

    await adapter.persistEvidence(evidence());
    await expect(adapter.persistEvidence(evidence({
      content: { answer: "changed" },
    }))).resolves.toMatchObject({
      status: "failed",
      error: { code: "enterprise_evidence_identity_conflict" },
    });
    expect(client.commits).toHaveLength(1);
    expect(client.reconciliations).toHaveLength(1);
  });

  it("rejects oversized or non-JSON Evidence before contacting storage", async () => {
    const client = new FakeEnterpriseEvidenceClient();
    const adapter = createAdapter(client, {
      ...policy(),
      maxEvidenceBytes: 32,
    });

    await expect(adapter.persistEvidence(evidence({
      content: { answer: "this content exceeds the deliberately tiny limit" },
    }))).resolves.toMatchObject({
      status: "failed",
      error: { code: "enterprise_evidence_invalid" },
    });
    await expect(adapter.persistEvidence(evidence({
      id: "evidence_2",
      content: { invalid: BigInt(1) },
    }))).resolves.toMatchObject({
      status: "failed",
      error: { code: "enterprise_evidence_invalid" },
    });
    expect(client.commits).toHaveLength(0);
  });

  it("deduplicates concurrent persistence of the same immutable Evidence", async () => {
    let settle: ((outcome: EnterpriseEvidenceCommitOutcome) => void) | undefined;
    const commit = vi.fn((input: EnterpriseEvidenceCommitInput) =>
      new Promise<EnterpriseEvidenceCommitOutcome>((resolve) => {
        settle = resolve;
      }).then((outcome) => outcome.status === "committed"
        ? { ...outcome, receipt: receipt(input) }
        : outcome));
    const client = new FakeEnterpriseEvidenceClient({ commit });
    const adapter = createAdapter(client);

    const first = adapter.persistEvidence(evidence());
    const second = adapter.persistEvidence(evidence());
    settle?.({
      status: "committed",
      receipt: {} as EnterpriseEvidenceCommitReceipt,
    });

    await expect(first).resolves.toMatchObject({ status: "stored" });
    await expect(second).resolves.toMatchObject({ status: "stored" });
    expect(commit).toHaveBeenCalledOnce();
  });
});

class FakeEnterpriseEvidenceClient implements EnterpriseEvidencePersistenceClient {
  readonly commits: EnterpriseEvidenceCommitInput[] = [];
  readonly reconciliations: EnterpriseEvidenceReconciliationInput[] = [];

  constructor(
    private readonly handlers: {
      readonly commit?: (
        input: EnterpriseEvidenceCommitInput,
      ) => Promise<EnterpriseEvidenceCommitOutcome>;
      readonly reconcile?: (
        input: EnterpriseEvidenceReconciliationInput,
      ) => Promise<EnterpriseEvidenceReconciliationOutcome>;
    } = {},
  ) {}

  async commitEvidence(
    input: EnterpriseEvidenceCommitInput,
  ): Promise<EnterpriseEvidenceCommitOutcome> {
    this.commits.push(input);
    return this.handlers.commit?.(input) ?? {
      status: "committed",
      receipt: receipt(input),
    };
  }

  async reconcileEvidenceCommit(
    input: EnterpriseEvidenceReconciliationInput,
  ): Promise<EnterpriseEvidenceReconciliationOutcome> {
    this.reconciliations.push(input);
    return this.handlers.reconcile?.(input) ?? {
      status: "unresolved",
      reconciliationToken: input.reconciliationToken,
      failure: failure(
        "enterprise_reconciliation_unconfigured",
        "Reconciliation is not configured.",
        false,
      ),
    };
  }
}

function createAdapter(
  client: EnterpriseEvidencePersistenceClient,
  inputPolicy = policy(),
): EnterpriseEvidencePersistenceAdapter {
  return new EnterpriseEvidencePersistenceAdapter({
    client,
    commitNamespace: "tenant-a",
    workspaceId: "workspace_1",
    actorRef: "user_1",
    auditCorrelationId: "audit_1",
    policy: inputPolicy,
  });
}

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: "evidence_1",
    source: {
      kind: "toolResult",
      toolCallId: "tool_call_1",
      toolName: "codeAgent.readFile",
    },
    summary: "Read workspace file.",
    content: { answer: "ok" },
    sensitivity: "restricted",
    metadata: {},
    ...overrides,
  };
}

function policy(): EnterpriseEvidencePersistencePolicy {
  return {
    retentionPolicyBySensitivity: {
      public: "retention-public",
      private: "retention-private",
      secret: "retention-secret",
      restricted: "retention-restricted",
    },
    accessPolicyBySensitivity: {
      public: "access-public",
      private: "access-private",
      secret: "access-secret",
      restricted: "access-restricted",
    },
    maxEvidenceBytes: 1_000_000,
  };
}

function receipt(
  input: EnterpriseEvidenceCommitInput,
): EnterpriseEvidenceCommitReceipt {
  return {
    commitId: input.commitId,
    storageId: `storage_${input.evidence.id}`,
    evidenceRef: input.evidence.id,
    artifactRef: `enterprise://evidence/${input.evidence.id}`,
    createdAt: NOW,
    workspaceId: input.workspaceId,
    actorRef: input.actorRef,
    retentionPolicyRef: input.retentionPolicyRef,
    accessPolicyRef: input.accessPolicyRef,
    sensitivity: input.sensitivity,
    auditCorrelationId: input.auditCorrelationId,
    safeMetadata: { backend: "test" },
  };
}

function receiptFromReconciliation(
  input: EnterpriseEvidenceReconciliationInput,
): EnterpriseEvidenceCommitReceipt {
  return {
    commitId: input.commitId,
    storageId: `storage_${input.evidenceRef}`,
    evidenceRef: input.evidenceRef,
    artifactRef: `enterprise://evidence/${input.evidenceRef}`,
    createdAt: NOW,
    workspaceId: "workspace_1",
    actorRef: "user_1",
    retentionPolicyRef: "retention-restricted",
    accessPolicyRef: "access-restricted",
    sensitivity: "restricted",
    auditCorrelationId: "audit_1",
    safeMetadata: { backend: "test" },
  };
}

function failure(
  code: string,
  message: string,
  retryable: boolean,
) {
  return { code, message, retryable, metadata: {} };
}
