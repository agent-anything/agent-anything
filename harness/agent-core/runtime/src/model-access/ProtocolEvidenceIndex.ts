import type { ProtocolRevisionRef } from "@agent-anything/model-interaction/protocol";
import type { ProtocolContentRef, ProtocolExecutionFence } from "./ProtocolExecutionJournal.js";

/** Explicitly accepted disclosure/ownership boundary, independent of activity identity. */
export interface ProtocolEvidenceScope {
  readonly id: string;
  readonly runId: string;
  readonly recipientId: string;
  readonly purpose: ProtocolRevisionRef;
  readonly compositionDigest: string;
  readonly owner: string;
}
export type ProtocolEvidenceKind = "continuation" | "measurement" | "usage" | "transport" | "transformation";
export type ProtocolEvidenceMetadata = Readonly<Record<string, string | number | boolean | null>>;
export interface ProtocolEvidenceRecordRef {
  readonly activityId: string;
  readonly ref: ProtocolRevisionRef;
}
export interface ProtocolEvidenceRevision {
  readonly scopeId: string;
  readonly kind: ProtocolEvidenceKind;
  /** Native owner supplies the exact continuation, measurement binding or unique-work key. */
  readonly key: string;
  readonly owner: string;
  readonly activityId: string;
  readonly revision: number;
  /** Serialized owner-defined evidence, including per-work reservation disposition. */
  readonly content: ProtocolContentRef;
  /** Exact frozen manifest, input and dependency/hold evidence content; never raw bodies. */
  readonly references: readonly ProtocolContentRef[];
  readonly dependencies: readonly ProtocolEvidenceRecordRef[];
  /** At most 32 scalar fields / 4096 UTF-8 bytes; each string at most 1024 UTF-8 bytes. No native payloads or secrets. */
  readonly metadata: ProtocolEvidenceMetadata;
  /** Usage-only attribution memberships. Membership never grants body access. */
  readonly memberships: readonly string[];
}
export interface ProtocolEvidenceWrite {
  readonly fence: ProtocolExecutionFence;
  /** null creates revision 0; otherwise the next revision must be expectedRevision + 1. */
  readonly expectedRevision: number | null;
  readonly evidence: ProtocolEvidenceRevision;
}
export interface ProtocolUsageMergeProposal {
  readonly scopeId: string;
  readonly mergeId: string;
  readonly survivor: ProtocolEvidenceWrite;
  /** One to 128 distinct keys. null also retires a key not yet published. */
  readonly retired: readonly { readonly key: string; readonly fence: ProtocolExecutionFence; readonly expectedRevision: number | null }[];
}
/** Immutable explicit alias, never followed by an ordinary evidence read. */
export interface ProtocolUsageRetirement {
  readonly scopeId: string;
  readonly key: string;
  readonly owner: string;
  readonly activityId: string;
  readonly mergeId: string;
  readonly acceptanceId: string;
  readonly previous: { readonly revision: number; readonly content: ProtocolContentRef } | null;
  readonly survivor: { readonly key: string; readonly revision: number; readonly content: ProtocolContentRef };
}
/** Complete committed merge, also the value of the usage_merge journal fact. */
export interface ProtocolUsageMerge {
  readonly scopeId: string;
  readonly mergeId: string;
  readonly owner: string;
  readonly acceptanceId: string;
  readonly version: number;
  /** Original accepted attempt, including its fences/CAS, for exact receipt recovery. */
  readonly proposal: ProtocolUsageMergeProposal;
  readonly survivor: ProtocolEvidenceRevision;
  readonly retired: readonly ProtocolUsageRetirement[];
}
export type ProtocolEvidencePart = { readonly owner: "protocol_execution" } & (
  /** Coordinator explicitly binds each participating activity; matching properties alone do not grant membership. */
  | { readonly kind: "evidence_scope"; readonly proposal: { readonly activityId: string; readonly scope: ProtocolEvidenceScope } }
  | { readonly kind: "evidence"; readonly proposal: ProtocolEvidenceWrite }
  | { readonly kind: "usage_merge"; readonly proposal: ProtocolUsageMergeProposal }
);
export type ProtocolEvidenceCommand =
  | { readonly kind: "evidence_scope"; readonly activityId: string; readonly scopeId: string }
  | { readonly kind: "evidence"; readonly activityId: string; readonly scopeId: string; readonly evidenceKind: ProtocolEvidenceKind;
      readonly key: string; readonly revision?: number }
  | { readonly kind: "usage_retirement"; readonly activityId: string; readonly scopeId: string; readonly key: string }
  | { readonly kind: "usage_merge"; readonly activityId: string; readonly scopeId: string; readonly mergeId: string }
  | { readonly kind: "evidence_list"; readonly activityId: string; readonly scopeId: string; readonly evidenceKind: ProtocolEvidenceKind;
      readonly afterKey: string | null; readonly limit: number; readonly membership?: string;
      /** Required for usage continuation pages; a changed index rejects the page. */
      readonly expectedVersion?: number };
export interface ProtocolEvidencePage {
  readonly entries: readonly ProtocolEvidenceRevision[];
  readonly next: string | null;
  /** Scope-local usage index version; null for non-usage pages. */
  readonly version: number | null;
}
