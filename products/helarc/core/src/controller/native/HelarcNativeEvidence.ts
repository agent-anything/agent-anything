import type { SharedAcceptancePort } from "@agent-anything/agent-runtime/activity";
import { readProtocolContent, retainProtocolContent, type ProtocolExecutionJournal, type ProtocolExecutionFence,
  type ProtocolEvidenceRevision, type ProtocolEvidenceScope, type ProtocolEvidenceKind, type ProtocolEvidenceMetadata,
  type ProtocolEvidenceRecordRef, type ProtocolContentRef, type ProtocolContentWork } from "@agent-anything/agent-runtime/model-access";
import { modelInputValueDigest } from "@agent-anything/model-interaction/input";
import { snapshotModelJsonValue } from "@agent-anything/model-interaction";

/** Owner-defined native evidence is stored separately from the bounded observation/index path. */
export async function retainHelarcNativeEvidence(input: {
  readonly journal: ProtocolExecutionJournal;
  readonly acceptance: SharedAcceptancePort;
  readonly scope: ProtocolEvidenceScope;
  readonly fence: ProtocolExecutionFence;
  readonly kind: ProtocolEvidenceKind;
  readonly key: string;
  readonly expectedRevision: number | null;
  readonly value: unknown;
  readonly references: readonly ProtocolContentRef[];
  readonly dependencies: readonly ProtocolEvidenceRecordRef[];
  readonly metadata: ProtocolEvidenceMetadata;
  readonly memberships: readonly string[];
  readonly observe?: (work: ProtocolContentWork) => void;
}): Promise<ProtocolEvidenceRevision> {
  const bytes = Buffer.from(JSON.stringify(snapshotModelJsonValue(input.value, "native evidence"))), id = `${input.fence.activityId}:${input.kind}:${modelInputValueDigest(input.value)}`;
  const content = await retainProtocolContent(input.journal, id, input.fence.activityId, bytes, input.observe);
  const evidence: ProtocolEvidenceRevision = { scopeId: input.scope.id, kind: input.kind, key: input.key, owner: input.scope.owner,
    activityId: input.fence.activityId, revision: input.expectedRevision === null ? 0 : input.expectedRevision + 1, content,
    references: input.references, dependencies: input.dependencies, metadata: input.metadata, memberships: input.memberships };
  // An accepted immutable revision is the recovery proof even when its acknowledgement was lost.
  const accepted = await input.journal.command({ kind: "evidence", activityId: input.fence.activityId,
    scopeId: input.scope.id, evidenceKind: input.kind, key: input.key, revision: evidence.revision }) as ProtocolEvidenceRevision | null;
  if (accepted) {
    if (modelInputValueDigest(accepted) !== modelInputValueDigest(evidence)) throw new TypeError("native_evidence_revision_conflict");
    return accepted;
  }
  const proposal = { scope: input.scope.runId, actor: input.scope.owner,
    parts: [{ owner: "protocol_execution", kind: "evidence", proposal: { fence: input.fence, expectedRevision: input.expectedRevision, evidence } }] };
  // Renewed authority creates a new attempt, not a different immutable evidence revision.
  const receipt = await input.acceptance.accept({ id: `native-evidence:${modelInputValueDigest(proposal)}`, ...proposal });
  if (receipt.outcome !== "accepted") throw new TypeError(`native_evidence_not_accepted:${receipt.rejection?.code}`);
  return evidence;
}

/** Explicit full-body access, not performed by state observation or aggregate refresh. */
export async function readHelarcNativeEvidence<T>(input: {
  readonly journal: ProtocolExecutionJournal;
  readonly activityId: string;
  readonly scopeId: string;
  readonly kind: ProtocolEvidenceKind;
  readonly key: string;
  readonly revision?: number;
  readonly restore: (value: unknown) => T;
  readonly maximumBytes: number;
  readonly observe?: (work: ProtocolContentWork) => void;
}): Promise<{ readonly evidence: ProtocolEvidenceRevision; readonly value: T } | null> {
  const evidence = await input.journal.command({ kind: "evidence", activityId: input.activityId, scopeId: input.scopeId,
    evidenceKind: input.kind, key: input.key, ...(input.revision === undefined ? {} : { revision: input.revision }) }) as ProtocolEvidenceRevision | null;
  if (!evidence) return null;
  const bytes = await readProtocolContent(input.journal, evidence.content, evidence.content.activityId, input.maximumBytes, input.observe);
  return { evidence, value: input.restore(JSON.parse(bytes.toString("utf8"))) };
}
