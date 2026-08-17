import type { ArtifactRef } from "@agent-anything/agent-core/run";
import type {
  EvidencePersistenceError,
  EvidencePersistencePort,
  StoredEvidenceArtifact,
} from "../persistence/index.js";
import type { Evidence } from "./Evidence.js";
import type { EvidenceBuilderPort } from "./EvidenceBuilder.js";
import { snapshotEvidenceContribution } from "./EvidenceBuilder.js";
import type { EvidenceRef } from "./EvidenceRef.js";
import type { EvidenceContribution } from "./EvidenceSource.js";

export interface EvidenceSettlementFailure {
  readonly code:
    | "context_evidence_creation_failed"
    | "context_evidence_persistence_failed";
  readonly message: string;
  readonly retryable: false;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type EvidenceSettlementResult =
  | {
      readonly status: "settled" | "interrupted";
      readonly evidenceRefs: readonly EvidenceRef[];
      readonly artifactRefs: readonly ArtifactRef[];
    }
  | {
      readonly status: "failed";
      readonly evidenceRefs: readonly EvidenceRef[];
      readonly artifactRefs: readonly ArtifactRef[];
      readonly failure: EvidenceSettlementFailure;
    };

export async function settleEvidenceContribution(input: {
  readonly actionId: string;
  readonly contribution: EvidenceContribution;
  readonly evidenceBuilder: EvidenceBuilderPort;
  readonly persistence: EvidencePersistencePort;
  readonly isInterrupted: () => boolean;
}): Promise<EvidenceSettlementResult> {
  if (input.isInterrupted()) return settled("interrupted", [], []);

  let contribution: EvidenceContribution;
  let evidence: readonly Evidence[];
  try {
    contribution = snapshotEvidenceContribution(input.contribution);
    evidence = snapshotEvidence(
      input.evidenceBuilder.build({ contribution }),
      contribution,
    );
  } catch (error) {
    return failed(
      "context_evidence_creation_failed",
      error instanceof Error ? error.message : "Failed to build Evidence from an attributed contribution.",
      { actionId: input.actionId },
      [],
      [],
    );
  }

  const evidenceRefs: EvidenceRef[] = [];
  const artifactRefs: ArtifactRef[] = [];
  for (const item of evidence) {
    if (input.isInterrupted()) return settled("interrupted", evidenceRefs, artifactRefs);
    try {
      const result = await input.persistence.persistEvidence(item);
      if (result.status === "failed") {
        return persistenceFailed(input.actionId, item.id, result.error, evidenceRefs, artifactRefs);
      }
      const stored = snapshotStoredEvidenceArtifact(result.artifact, item.id);
      evidenceRefs.push(stored.evidenceRef);
      artifactRefs.push(stored.artifactRef);
    } catch (error) {
      return failed(
        "context_evidence_persistence_failed",
        error instanceof Error ? error.message : "Failed to persist Evidence.",
        { actionId: input.actionId, evidenceId: item.id },
        evidenceRefs,
        artifactRefs,
      );
    }
  }
  return settled(input.isInterrupted() ? "interrupted" : "settled", evidenceRefs, artifactRefs);
}

function snapshotEvidence(
  candidate: readonly Evidence[],
  contribution: EvidenceContribution,
): readonly Evidence[] {
  if (!Array.isArray(candidate)) throw new TypeError("EvidenceBuilderPort must return an array.");
  const ids = new Set<string>();
  return Object.freeze(candidate.map((item) => {
    if (
      item === null || typeof item !== "object" || typeof item.id !== "string" ||
      item.id.length === 0 || ids.has(item.id) ||
      !sameSource(item.source, contribution.source) ||
      typeof item.summary !== "string" ||
      !["public", "private", "secret", "restricted"].includes(item.sensitivity) ||
      !isRecord(item.metadata)
    ) throw new TypeError("EvidenceBuilderPort returned Evidence that does not match its contribution.");
    ids.add(item.id);
    return Object.freeze({ ...item, metadata: Object.freeze({ ...item.metadata }) });
  }));
}

function sameSource(left: Evidence["source"], right: EvidenceContribution["source"]): boolean {
  return left.owner === right.owner && left.kind === right.kind &&
    left.id === right.id && left.revision === right.revision;
}

function persistenceFailed(
  actionId: string,
  evidenceId: string,
  error: EvidencePersistenceError,
  evidenceRefs: readonly EvidenceRef[],
  artifactRefs: readonly ArtifactRef[],
): EvidenceSettlementResult {
  if (!isRecord(error) || typeof error.code !== "string" || error.code.length === 0 ||
      typeof error.message !== "string" || typeof error.retryable !== "boolean" ||
      !isRecord(error.metadata)) {
    return failed("context_evidence_persistence_failed", "EvidencePersistencePort returned an invalid failure.", { actionId, evidenceId }, evidenceRefs, artifactRefs);
  }
  return failed("context_evidence_persistence_failed", error.message, {
    ...error.metadata,
    actionId,
    evidenceId,
    persistenceCode: error.code,
    persistenceRetryable: error.retryable,
  }, evidenceRefs, artifactRefs);
}

function snapshotStoredEvidenceArtifact(candidate: StoredEvidenceArtifact, evidenceId: string): StoredEvidenceArtifact {
  if (!isRecord(candidate) || typeof candidate.storageId !== "string" || candidate.storageId.length === 0 ||
      candidate.evidenceRef !== evidenceId || typeof candidate.artifactRef !== "string" || candidate.artifactRef.length === 0 ||
      typeof candidate.createdAt !== "string" || candidate.createdAt.length === 0 || !isRecord(candidate.metadata)) {
    throw new TypeError("EvidencePersistencePort returned an invalid or uncorrelated StoredEvidenceArtifact.");
  }
  return Object.freeze({ ...candidate, metadata: Object.freeze({ ...candidate.metadata }) }) as StoredEvidenceArtifact;
}

function settled(status: "settled" | "interrupted", evidenceRefs: readonly EvidenceRef[], artifactRefs: readonly ArtifactRef[]): EvidenceSettlementResult {
  return Object.freeze({ status, evidenceRefs: Object.freeze([...evidenceRefs]), artifactRefs: Object.freeze([...artifactRefs]) });
}

function failed(code: EvidenceSettlementFailure["code"], message: string, metadata: Readonly<Record<string, unknown>>, evidenceRefs: readonly EvidenceRef[], artifactRefs: readonly ArtifactRef[]): EvidenceSettlementResult {
  return Object.freeze({
    status: "failed" as const,
    evidenceRefs: Object.freeze([...evidenceRefs]),
    artifactRefs: Object.freeze([...artifactRefs]),
    failure: Object.freeze({ code, message, retryable: false, metadata: Object.freeze({ ...metadata }) }),
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
