import {
  isSessionAuthorityApplicable,
  type SessionAuthorityCommit,
  type SessionAuthorityCommitResult,
  type SessionAuthorityLookup,
  type SessionAuthorityPort,
  type SessionAuthorityRecord,
} from "@agent-anything/permission";
import type { InvocationInterruptionContext } from "@agent-anything/shared";

export interface InMemoryHostSessionAuthorityStore extends SessionAuthorityPort {
  listRecords(): readonly SessionAuthorityRecord[];
}

export interface CreateInMemoryHostSessionAuthorityStoreInput {
  readonly maxRecords: number;
  readonly initialRecords?: readonly SessionAuthorityRecord[];
}

interface CommitLedgerEntry {
  readonly fingerprint: string;
  readonly result: SessionAuthorityCommitResult;
}

export function createInMemoryHostSessionAuthorityStore(
  input: CreateInMemoryHostSessionAuthorityStoreInput,
): InMemoryHostSessionAuthorityStore {
  assertLimit(input.maxRecords, "Session authority maxRecords");
  const records = new Map<string, SessionAuthorityRecord>();
  const commits = new Map<string, CommitLedgerEntry>();

  for (const record of input.initialRecords ?? []) {
    if (records.size >= input.maxRecords) {
      throw new TypeError("Initial Session authority records exceed maxRecords.");
    }
    if (records.has(record.id)) {
      throw new TypeError(`Duplicate Session authority record '${record.id}'.`);
    }
    records.set(record.id, snapshot(record));
  }

  return Object.freeze({
    async listApplicable(
      lookup: SessionAuthorityLookup,
      context: InvocationInterruptionContext,
    ) {
      if (context.signal.aborted) return Object.freeze([]);
      return Object.freeze(
        [...records.values()]
          .filter((record) => isSessionAuthorityApplicable(record, lookup))
          .map(snapshot),
      );
    },

    async commit(
      commit: SessionAuthorityCommit,
      context: InvocationInterruptionContext,
    ): Promise<SessionAuthorityCommitResult> {
      if (context.signal.aborted && context.interruption !== null) {
        return Object.freeze({
          kind: "interrupted" as const,
          interruption: context.interruption,
        });
      }

      const record = snapshot(commit.record);
      const fingerprint = JSON.stringify(record);
      const prior = commits.get(commit.commitId);
      if (prior !== undefined) {
        return prior.fingerprint === fingerprint
          ? prior.result
          : notApplied("session_authority_conflict", "Session authority commit id was reused with different content.");
      }

      const existing = records.get(record.id);
      if (existing !== undefined && JSON.stringify(existing) !== fingerprint) {
        return notApplied("session_authority_conflict", "Session authority record id conflicts with existing authority.");
      }
      if (existing === undefined && records.size >= input.maxRecords) {
        return notApplied("session_authority_storage_failed", "Session authority store reached its record limit.");
      }

      records.set(record.id, record);
      const result = Object.freeze({ kind: "applied" as const, record });
      commits.set(commit.commitId, { fingerprint, result });
      return result;
    },

    listRecords() {
      return Object.freeze([...records.values()].map(snapshot));
    },
  });
}

function notApplied(
  code: "session_authority_conflict" | "session_authority_storage_failed",
  message: string,
): SessionAuthorityCommitResult {
  return Object.freeze({ kind: "not_applied", code, message });
}

function snapshot(record: SessionAuthorityRecord): SessionAuthorityRecord {
  return deepFreeze(structuredClone(record));
}

function assertLimit(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
