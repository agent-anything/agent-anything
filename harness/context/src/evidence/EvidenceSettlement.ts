import type { ArtifactRef, EvidenceRef, Metadata } from "@agent-anything/foundation";
import type { ToolResult } from "@agent-anything/tools";
import type { RuntimeError } from "@agent-anything/foundation";
import type { Evidence } from "./Evidence.js";
import type { EvidenceBuilderPort } from "./EvidenceBuilder.js";
import type {
  EvidencePersistenceError,
  EvidencePersistencePort,
  StoredEvidenceArtifact,
} from "../persistence/index.js";

export interface ValidToolResultClassification {
  readonly status: "valid";
  readonly createObservation: boolean;
  readonly createEvidence: boolean;
  readonly failed: boolean;
}

export type ToolResultClassification =
  | ValidToolResultClassification
  | { readonly status: "invalid"; readonly error: RuntimeError };

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
      readonly error: RuntimeError;
    };

export function classifyToolResult(toolResult: ToolResult): ToolResultClassification {
  const metadata = toolResultMetadata(toolResult);
  switch (toolResult.status) {
    case "succeeded":
      return toolResult.output === null || toolResult.error !== null
        ? invalidToolResult("Succeeded ToolResult requires non-null output and no error.", metadata)
        : valid(true, true, false);
    case "partial":
      return toolResult.output === null
        ? invalidToolResult("Partial ToolResult requires non-null output.", metadata)
        : valid(true, true, true);
    case "interrupted":
      return toolResult.output === null
        ? invalidToolResult("Interrupted ToolResult requires non-null usable output.", metadata)
        : valid(true, true, true);
    case "failed":
    case "cancelled":
    case "timeout":
      return valid(true, false, true);
    case "skipped":
      return toolResult.output !== null || toolResult.error !== null
        ? invalidToolResult("Skipped ToolResult cannot include output or an error.", metadata)
        : valid(false, false, false);
  }
}

export async function settleToolResultEvidence(input: {
  readonly actionId: string;
  readonly toolResult: ToolResult;
  readonly classification: ValidToolResultClassification;
  readonly evidenceBuilder: EvidenceBuilderPort;
  readonly persistence: EvidencePersistencePort;
  readonly isInterrupted: () => boolean;
}): Promise<EvidenceSettlementResult> {
  if (!input.classification.createEvidence || input.isInterrupted()) {
    return settled(input.isInterrupted() ? "interrupted" : "settled", [], []);
  }

  let evidence: readonly Evidence[];
  try {
    evidence = snapshotEvidence(input.evidenceBuilder.buildFromToolResult({
      toolResult: input.toolResult,
    }), input.toolResult);
  } catch (error) {
    return failed(
      "tool",
      "tool_evidence_creation_failed",
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
        "storage",
        "storage_write_failed",
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
      "storage",
      "storage_write_failed",
      "EvidencePersistencePort returned an invalid failure.",
      { actionId, evidenceId },
      evidenceRefs,
      artifactRefs,
    );
  }

  return failed(
    "storage",
    "storage_write_failed",
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

function valid(
  createObservation: boolean,
  createEvidence: boolean,
  failed: boolean,
): ValidToolResultClassification {
  return Object.freeze({ status: "valid", createObservation, createEvidence, failed });
}

function invalidToolResult(message: string, metadata: Metadata): ToolResultClassification {
  return Object.freeze({
    status: "invalid" as const,
    error: runtimeError("tool", "tool_result_invalid", message, metadata),
  });
}

function snapshotEvidence(candidate: Evidence[], toolResult: ToolResult): readonly Evidence[] {
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
  owner: "tool" | "storage",
  code: string,
  message: string,
  metadata: Metadata,
  evidenceRefs: readonly EvidenceRef[],
  artifactRefs: readonly ArtifactRef[],
): EvidenceSettlementResult {
  return Object.freeze({
    status: "failed" as const,
    evidenceRefs: Object.freeze([...evidenceRefs]),
    artifactRefs: Object.freeze([...artifactRefs]),
    error: runtimeError(owner, code, message, metadata),
  });
}

function runtimeError(
  owner: "tool" | "storage",
  code: string,
  message: string,
  metadata: Metadata,
): RuntimeError {
  return Object.freeze({
    owner,
    code,
    message,
    retryable: false,
    metadata: Object.freeze({ ...metadata }),
  });
}

function toolResultMetadata(toolResult: ToolResult): Metadata {
  return Object.freeze({
    toolCallId: toolResult.toolCallId,
    toolName: toolResult.toolName,
    toolResultStatus: toolResult.status,
  });
}
