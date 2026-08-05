import type { ArtifactRef } from "@agent-anything/agent-core/run";
import type { EvidenceRef } from "./EvidenceRef.js";
import type { ToolResult } from "@agent-anything/tools";
import type { ContextFailure } from "../ContextFailure.js";
import type { Evidence } from "./Evidence.js";
import type { EvidenceBuilderPort } from "./EvidenceBuilder.js";
import type {
  EvidencePersistenceError,
  EvidencePersistencePort,
  StoredEvidenceArtifact,
} from "../persistence/index.js";

export interface ToolResultClassification {
  readonly createEvidence: boolean;
  readonly failed: boolean;
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
      readonly failure: ContextFailure;
    };

export function classifyToolResult(toolResult: ToolResult): ToolResultClassification {
  switch (toolResult.status) {
    case "succeeded":
      return classification(true, false);
    case "partial":
      return classification(true, true);
    case "failed":
    case "timeout":
      return classification(false, true);
  }
}

export async function settleToolResultEvidence(input: {
  readonly actionId: string;
  readonly toolResult: ToolResult;
  readonly evidenceBuilder: EvidenceBuilderPort;
  readonly persistence: EvidencePersistencePort;
  readonly isInterrupted: () => boolean;
}): Promise<EvidenceSettlementResult> {
  if (
    input.toolResult.status === "failed" ||
    input.toolResult.status === "timeout" ||
    input.isInterrupted()
  ) {
    return settled(input.isInterrupted() ? "interrupted" : "settled", [], []);
  }

  let evidence: readonly Evidence[];
  try {
    evidence = snapshotEvidence(input.evidenceBuilder.buildFromToolResult({
      toolResult: input.toolResult,
    }), input.toolResult);
  } catch (error) {
    return failed(
      "context_evidence_creation_failed",
      error instanceof Error ? error.message : "Failed to build Evidence from ToolResult.",
      { actionId: input.actionId, ...toolResultMetadata(input.toolResult) },
      [],
      [],
    );
  }

  const evidenceRefs: EvidenceRef[] = [];
  const artifactRefs: ArtifactRef[] = [];
  for (const item of evidence) {
    if (input.isInterrupted()) {
      return settled("interrupted", evidenceRefs, artifactRefs);
    }
    try {
      const result = await input.persistence.persistEvidence(item);
      if (result.status === "failed") {
        return persistenceFailed(
          input.actionId,
          item.id,
          result.error,
          evidenceRefs,
          artifactRefs,
        );
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

function persistenceFailed(
  actionId: string,
  evidenceId: string,
  error: EvidencePersistenceError,
  evidenceRefs: readonly EvidenceRef[],
  artifactRefs: readonly ArtifactRef[],
): EvidenceSettlementResult {
  if (
    error === null ||
    typeof error !== "object" ||
    typeof error.code !== "string" ||
    error.code.length === 0 ||
    typeof error.message !== "string" ||
    typeof error.retryable !== "boolean" ||
    error.metadata === null ||
    typeof error.metadata !== "object"
  ) {
    return failed(
      "context_evidence_persistence_failed",
      "EvidencePersistencePort returned an invalid failure.",
      { actionId, evidenceId },
      evidenceRefs,
      artifactRefs,
    );
  }

  return failed(
    "context_evidence_persistence_failed",
    error.message,
    {
      ...error.metadata,
      actionId,
      evidenceId,
      persistenceCode: error.code,
      persistenceRetryable: error.retryable,
    },
    evidenceRefs,
    artifactRefs,
  );
}

function snapshotStoredEvidenceArtifact(
  candidate: StoredEvidenceArtifact,
  evidenceId: string,
): StoredEvidenceArtifact {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof candidate.storageId !== "string" ||
    candidate.storageId.length === 0 ||
    candidate.evidenceRef !== evidenceId ||
    typeof candidate.artifactRef !== "string" ||
    candidate.artifactRef.length === 0 ||
    typeof candidate.createdAt !== "string" ||
    candidate.createdAt.length === 0 ||
    candidate.metadata === null ||
    typeof candidate.metadata !== "object"
  ) {
    throw new TypeError(
      "EvidencePersistencePort returned an invalid or uncorrelated StoredEvidenceArtifact.",
    );
  }

  return Object.freeze({
    ...candidate,
    metadata: Object.freeze({ ...candidate.metadata }),
  });
}

function classification(
  createEvidence: boolean,
  failed: boolean,
): ToolResultClassification {
  return Object.freeze({ createEvidence, failed });
}

function snapshotEvidence(candidate: readonly Evidence[], toolResult: ToolResult): readonly Evidence[] {
  if (!Array.isArray(candidate)) throw new TypeError("EvidenceBuilderPort must return an array.");
  const ids = new Set<string>();
  return Object.freeze(candidate.map((item) => {
    if (
      item === null ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      item.id.length === 0 ||
      ids.has(item.id) ||
      item.source?.kind !== "toolResult" ||
      item.source.toolCallId !== toolResult.toolCallId ||
      item.source.toolName !== toolResult.toolName ||
      typeof item.summary !== "string" ||
      !["public", "private", "secret", "restricted"].includes(item.sensitivity) ||
      item.metadata === null ||
      typeof item.metadata !== "object"
    ) {
      throw new TypeError("EvidenceBuilderPort returned Evidence that does not match ToolResult.");
    }
    ids.add(item.id);
    return Object.freeze({ ...item, metadata: Object.freeze({ ...item.metadata }) });
  }));
}

function settled(
  status: "settled" | "interrupted",
  evidenceRefs: readonly EvidenceRef[],
  artifactRefs: readonly ArtifactRef[],
): EvidenceSettlementResult {
  return Object.freeze({
    status,
    evidenceRefs: Object.freeze([...evidenceRefs]),
    artifactRefs: Object.freeze([...artifactRefs]),
  });
}

function failed(
  code: string,
  message: string,
  metadata: Readonly<Record<string, unknown>>,
  evidenceRefs: readonly EvidenceRef[],
  artifactRefs: readonly ArtifactRef[],
): EvidenceSettlementResult {
  return Object.freeze({
    status: "failed" as const,
    evidenceRefs: Object.freeze([...evidenceRefs]),
    artifactRefs: Object.freeze([...artifactRefs]),
    failure: contextFailure(code, message, metadata),
  });
}

function contextFailure(
  code: string,
  message: string,
  metadata: Readonly<Record<string, unknown>>,
): ContextFailure {
  return Object.freeze({
    code,
    message,
    retryable: false,
    metadata: Object.freeze({ ...metadata }),
  });
}

function toolResultMetadata(toolResult: ToolResult): Readonly<Record<string, unknown>> {
  return Object.freeze({
    toolCallId: toolResult.toolCallId,
    toolName: toolResult.toolName,
    toolResultStatus: toolResult.status,
  });
}
