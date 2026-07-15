import {
  normalizePolicyAmendment,
  type AppliedPolicyAmendmentRecord,
  type PersistentPolicyAmendmentCommit,
  type PersistentPolicyAmendmentCommitResult,
  type PersistentPolicyAmendmentPort,
} from "@agent-anything/governance";
import type { InvocationInterruptionContext } from "@agent-anything/shared";

export interface InMemoryHostPolicyAmendmentStore
  extends PersistentPolicyAmendmentPort {
  listRecords(): readonly AppliedPolicyAmendmentRecord[];
}

export interface CreateInMemoryHostPolicyAmendmentStoreInput {
  readonly maxRecords: number;
}

interface CommitLedgerEntry {
  readonly fingerprint: string;
  readonly result: PersistentPolicyAmendmentCommitResult;
}

export function createInMemoryHostPolicyAmendmentStore(
  input: CreateInMemoryHostPolicyAmendmentStoreInput,
): InMemoryHostPolicyAmendmentStore {
  assertLimit(input.maxRecords);
  const records = new Map<string, AppliedPolicyAmendmentRecord>();
  const commits = new Map<string, CommitLedgerEntry>();

  return Object.freeze({
    async commit(
      commit: PersistentPolicyAmendmentCommit,
      context: InvocationInterruptionContext,
    ): Promise<PersistentPolicyAmendmentCommitResult> {
      if (context.signal.aborted && context.interruption !== null) {
        return Object.freeze({
          kind: "interrupted" as const,
          interruption: context.interruption,
        });
      }

      const normalized = normalizePolicyAmendment(commit.amendment);
      if (normalized.status === "invalid") {
        return notApplied("policy_amendment_invalid", normalized.message);
      }
      const record = deepFreeze({
        id: commit.recordId,
        proposalRef: commit.proposalRef,
        sourceRequestId: commit.sourceRequestId,
        sourceActionFingerprint: commit.sourceActionFingerprint,
        amendment: normalized.amendment,
        appliedAt: commit.appliedAt,
      });
      const fingerprint = JSON.stringify(record);
      const prior = commits.get(commit.commitId);
      if (prior !== undefined) {
        return prior.fingerprint === fingerprint
          ? prior.result
          : notApplied("policy_amendment_conflict", "Policy amendment commit id was reused with different content.");
      }

      const existing = records.get(record.id);
      if (existing !== undefined && JSON.stringify(existing) !== fingerprint) {
        return notApplied("policy_amendment_conflict", "Policy amendment record id conflicts with an existing amendment.");
      }
      if (existing === undefined && records.size >= input.maxRecords) {
        return notApplied("policy_amendment_storage_failed", "Policy amendment store reached its record limit.");
      }

      records.set(record.id, record);
      const result = Object.freeze({ kind: "applied" as const, record });
      commits.set(commit.commitId, { fingerprint, result });
      return result;
    },

    listRecords() {
      return Object.freeze([...records.values()].map((record) => deepFreeze(structuredClone(record))));
    },
  });
}

function notApplied(
  code: "policy_amendment_invalid" | "policy_amendment_conflict" | "policy_amendment_storage_failed",
  message: string,
): PersistentPolicyAmendmentCommitResult {
  return Object.freeze({ kind: "not_applied", code, message });
}

function assertLimit(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("Policy amendment maxRecords must be a non-negative integer.");
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
