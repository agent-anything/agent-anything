import type { Metadata } from "../shared/types.js";
import type { ToolResult } from "../tools/index.js";
import type { Evidence, EvidenceSensitivity } from "./Evidence.js";

export interface BuildEvidenceInput {
  toolResult: ToolResult;
  id?: string;
  summary?: string;
  sensitivity?: EvidenceSensitivity;
  metadata?: Metadata;
}

export interface EvidenceBuilderPort {
  buildFromToolResult(input: BuildEvidenceInput): Evidence[];
}

export class EvidenceBuilder implements EvidenceBuilderPort {
  buildFromToolResult(input: BuildEvidenceInput): Evidence[] {
    const { toolResult } = input;

    if (!hasUsableOutput(toolResult)) {
      return [];
    }

    return [
      {
        id: input.id ?? createEvidenceId(toolResult),
        source: {
          kind: "toolResult",
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
          metadata: toolResult.metadata,
        },
        summary: input.summary ?? createSummary(toolResult),
        content: toolResult.output,
        sensitivity:
          input.sensitivity ?? getSensitivityFromMetadata(toolResult.metadata),
        metadata: {
          ...input.metadata,
          createdFrom: toolResult.toolCallId,
        },
      },
    ];
  }
}

function createEvidenceId(toolResult: ToolResult): string {
  return `evidence_${toolResult.toolCallId}`;
}

function createSummary(toolResult: ToolResult): string {
  return toolResult.status === "partial"
    ? `Partial evidence from ${toolResult.toolName}.`
    : `Evidence from ${toolResult.toolName}.`;
}

function getSensitivityFromMetadata(metadata: Metadata): EvidenceSensitivity {
  return isEvidenceSensitivity(metadata.sensitivity)
    ? metadata.sensitivity
    : "public";
}

function hasUsableOutput(toolResult: ToolResult): boolean {
  if (toolResult.output === null) {
    return false;
  }

  return (
    toolResult.status === "succeeded" ||
    toolResult.status === "partial" ||
    toolResult.status === "interrupted"
  );
}

function isEvidenceSensitivity(value: unknown): value is EvidenceSensitivity {
  return (
    value === "public" ||
    value === "private" ||
    value === "secret" ||
    value === "restricted"
  );
}
