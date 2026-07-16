import type { Evidence, EvidenceBuilderPort } from "@agent-anything/evidence";
import type { ArtifactRef, EvidenceRef, Metadata } from "@agent-anything/shared";
import type { StoragePort } from "@agent-anything/storage";
import type { ToolResult } from "@agent-anything/tools";
import type { RuntimeError } from "./RuntimeError.js";

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
  readonly storage: StoragePort;
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

  const evidenceRefs = Object.freeze(evidence.map((item) => item.id));
  const artifactRefs: ArtifactRef[] = [];
  for (const item of evidence) {
    if (input.isInterrupted()) {
      return settled("interrupted", evidenceRefs, artifactRefs);
    }
    try {
      const artifact = await input.storage.storeEvidence(item);
      if (typeof artifact?.id !== "string" || artifact.id.length === 0) {
        throw new TypeError("StoragePort returned an invalid StoredArtifact id.");
      }
      artifactRefs.push(artifact.id);
    } catch (error) {
      return failed(
        "storage",
        "storage_write_failed",
        error instanceof Error ? error.message : "Failed to store Evidence.",
        { actionId: input.actionId, evidenceId: item.id },
        evidenceRefs,
        artifactRefs,
      );
    }
  }

  return settled(input.isInterrupted() ? "interrupted" : "settled", evidenceRefs, artifactRefs);
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
