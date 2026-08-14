export interface HelarcOwnedRecordRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string | null;
}

export type HelarcAuthorityProjectionState =
  | "requested"
  | "resolved"
  | "applied"
  | "declined"
  | "expired"
  | "cancelled"
  | "failed";

export interface HelarcAuthorityProjection {
  readonly kind: "authority_projection";
  readonly id: string;
  readonly threadId: string;
  readonly runId: string;
  readonly authorityRef: HelarcOwnedRecordRef;
  readonly subjectRef: HelarcOwnedRecordRef;
  readonly state: HelarcAuthorityProjectionState;
  readonly summary: string;
  readonly projectedAt: string;
}

export type HelarcCollaborationRecord = HelarcAuthorityProjection;

export type HelarcProposalReviewIntent = "accept" | "reject" | "request_revision";

export interface HelarcProposalReviewRecord {
  readonly kind: "proposal_review";
  readonly id: string;
  readonly threadId: string;
  readonly runId: string;
  readonly proposalRef: HelarcOwnedRecordRef;
  readonly intent: HelarcProposalReviewIntent;
  readonly actorRef: HelarcOwnedRecordRef;
  readonly reason: string | null;
  readonly decidedAt: string;
}

export type HelarcEngineeringFindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface HelarcEngineeringReviewFinding {
  readonly id: string;
  readonly category: string;
  readonly severity: HelarcEngineeringFindingSeverity;
  readonly summary: string;
  readonly evidenceRefs: readonly HelarcOwnedRecordRef[];
  readonly validationRefs: readonly HelarcOwnedRecordRef[];
  readonly uncertainty: readonly string[];
}

export interface HelarcEngineeringReviewRecord {
  readonly kind: "engineering_review";
  readonly id: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly subjectRef: HelarcOwnedRecordRef;
  readonly reviewerRef: HelarcOwnedRecordRef;
  readonly findings: readonly HelarcEngineeringReviewFinding[];
  readonly coveredScopes: readonly string[];
  readonly uncoveredScopes: readonly string[];
  readonly uncertainty: readonly string[];
  readonly reportArtifactRef: HelarcOwnedRecordRef | null;
  readonly reviewedAt: string;
}

export type HelarcReviewRecord =
  | HelarcProposalReviewRecord
  | HelarcEngineeringReviewRecord;

export function snapshotHelarcCollaborationRecord(
  value: HelarcCollaborationRecord,
): HelarcCollaborationRecord | null {
  if (
    !hasExactKeys(value, [
      "kind", "id", "threadId", "runId", "authorityRef", "subjectRef", "state",
      "summary", "projectedAt",
    ]) || value.kind !== "authority_projection" || !hasIdentity(value.id) ||
    !hasIdentity(value.threadId) || !hasIdentity(value.runId) ||
    !isAuthorityState(value.state) || !hasIdentity(value.summary) ||
    !isDateTime(value.projectedAt)
  ) {
    return null;
  }
  const authorityRef = snapshotOwnedRecordRef(value.authorityRef);
  const subjectRef = snapshotOwnedRecordRef(value.subjectRef);
  if (authorityRef === null || subjectRef === null) return null;
  return Object.freeze({
    ...value,
    id: value.id.trim(),
    threadId: value.threadId.trim(),
    runId: value.runId.trim(),
    authorityRef,
    subjectRef,
    summary: value.summary.trim(),
  });
}

export function snapshotHelarcReviewRecord(value: HelarcReviewRecord): HelarcReviewRecord | null {
  if (value?.kind === "proposal_review") return snapshotProposalReview(value);
  if (value?.kind === "engineering_review") return snapshotEngineeringReview(value);
  return null;
}

function snapshotProposalReview(value: HelarcProposalReviewRecord): HelarcProposalReviewRecord | null {
  if (
    !hasExactKeys(value, [
      "kind", "id", "threadId", "runId", "proposalRef", "intent", "actorRef",
      "reason", "decidedAt",
    ]) || !hasIdentity(value.id) || !hasIdentity(value.threadId) ||
    !hasIdentity(value.runId) || !isProposalIntent(value.intent) ||
    (value.reason !== null && !hasIdentity(value.reason)) || !isDateTime(value.decidedAt)
  ) {
    return null;
  }
  const proposalRef = snapshotOwnedRecordRef(value.proposalRef);
  const actorRef = snapshotOwnedRecordRef(value.actorRef);
  if (proposalRef === null || actorRef === null) return null;
  return Object.freeze({
    ...value,
    id: value.id.trim(),
    threadId: value.threadId.trim(),
    runId: value.runId.trim(),
    proposalRef,
    actorRef,
    reason: value.reason?.trim() ?? null,
  });
}

function snapshotEngineeringReview(
  value: HelarcEngineeringReviewRecord,
): HelarcEngineeringReviewRecord | null {
  if (
    !hasExactKeys(value, [
      "kind", "id", "threadId", "runId", "subjectRef", "reviewerRef", "findings",
      "coveredScopes", "uncoveredScopes", "uncertainty", "reportArtifactRef", "reviewedAt",
    ]) || !hasIdentity(value.id) || !hasIdentity(value.threadId) ||
    (value.runId !== null && !hasIdentity(value.runId)) || !Array.isArray(value.findings) ||
    !Array.isArray(value.coveredScopes) || !Array.isArray(value.uncoveredScopes) ||
    !Array.isArray(value.uncertainty) || !isDateTime(value.reviewedAt)
  ) {
    return null;
  }
  const subjectRef = snapshotOwnedRecordRef(value.subjectRef);
  const reviewerRef = snapshotOwnedRecordRef(value.reviewerRef);
  const reportArtifactRef = value.reportArtifactRef === null
    ? null
    : snapshotOwnedRecordRef(value.reportArtifactRef);
  const findings = value.findings.map(snapshotFinding);
  const coveredScopes = snapshotTextList(value.coveredScopes);
  const uncoveredScopes = snapshotTextList(value.uncoveredScopes);
  const uncertainty = snapshotTextList(value.uncertainty);
  if (
    subjectRef === null || reviewerRef === null ||
    (value.reportArtifactRef !== null && reportArtifactRef === null) ||
    findings.some((finding) => finding === null) || coveredScopes === null ||
    uncoveredScopes === null || uncertainty === null || hasDuplicateIds(findings)
  ) {
    return null;
  }
  return Object.freeze({
    ...value,
    id: value.id.trim(),
    threadId: value.threadId.trim(),
    runId: value.runId?.trim() ?? null,
    subjectRef,
    reviewerRef,
    findings: Object.freeze(findings as HelarcEngineeringReviewFinding[]),
    coveredScopes,
    uncoveredScopes,
    uncertainty,
    reportArtifactRef,
  });
}

function snapshotFinding(
  value: HelarcEngineeringReviewFinding,
): HelarcEngineeringReviewFinding | null {
  if (
    !hasExactKeys(value, [
      "id", "category", "severity", "summary", "evidenceRefs", "validationRefs", "uncertainty",
    ]) || !hasIdentity(value.id) || !hasIdentity(value.category) ||
    !isFindingSeverity(value.severity) || !hasIdentity(value.summary) ||
    !Array.isArray(value.evidenceRefs) || !Array.isArray(value.validationRefs) ||
    !Array.isArray(value.uncertainty)
  ) {
    return null;
  }
  const evidenceRefs = value.evidenceRefs.map(snapshotOwnedRecordRef);
  const validationRefs = value.validationRefs.map(snapshotOwnedRecordRef);
  const uncertainty = snapshotTextList(value.uncertainty);
  if (
    evidenceRefs.some((reference) => reference === null) ||
    validationRefs.some((reference) => reference === null) || uncertainty === null
  ) {
    return null;
  }
  return Object.freeze({
    ...value,
    id: value.id.trim(),
    category: value.category.trim(),
    summary: value.summary.trim(),
    evidenceRefs: Object.freeze(evidenceRefs as HelarcOwnedRecordRef[]),
    validationRefs: Object.freeze(validationRefs as HelarcOwnedRecordRef[]),
    uncertainty,
  });
}

function snapshotOwnedRecordRef(value: HelarcOwnedRecordRef): HelarcOwnedRecordRef | null {
  if (
    !hasExactKeys(value, ["owner", "kind", "id", "revision"]) ||
    !hasIdentity(value.owner) || !hasIdentity(value.kind) || !hasIdentity(value.id) ||
    (value.revision !== null && !hasIdentity(value.revision))
  ) {
    return null;
  }
  return Object.freeze({
    owner: value.owner.trim(),
    kind: value.kind.trim(),
    id: value.id.trim(),
    revision: value.revision?.trim() ?? null,
  });
}

function snapshotTextList(value: readonly string[]): readonly string[] | null {
  const normalized = value.map((item) => item.trim());
  return normalized.some((item) => item.length === 0) || new Set(normalized).size !== normalized.length
    ? null
    : Object.freeze(normalized);
}

function hasDuplicateIds(values: readonly (HelarcEngineeringReviewFinding | null)[]): boolean {
  const ids = values.flatMap((value) => value === null ? [] : [value.id]);
  return new Set(ids).size !== ids.length;
}

function isAuthorityState(value: unknown): value is HelarcAuthorityProjectionState {
  return value === "requested" || value === "resolved" || value === "applied" ||
    value === "declined" || value === "expired" || value === "cancelled" || value === "failed";
}

function isProposalIntent(value: unknown): value is HelarcProposalReviewIntent {
  return value === "accept" || value === "reject" || value === "request_revision";
}

function isFindingSeverity(value: unknown): value is HelarcEngineeringFindingSeverity {
  return value === "info" || value === "low" || value === "medium" ||
    value === "high" || value === "critical";
}

function hasIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
