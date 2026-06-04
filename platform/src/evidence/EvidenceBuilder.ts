import type { Metadata } from "../shared/types";
import type { ToolResult } from "../tools";
import type { Evidence, EvidenceSensitivity } from "./Evidence";

export interface BuildEvidenceInput {
  toolResult: ToolResult;
  id?: string;
  summary?: string;
  sensitivity?: EvidenceSensitivity;
  metadata?: Metadata;
}

export class EvidenceBuilder {
  buildFromToolResult(input: BuildEvidenceInput): Evidence[] {
    const { toolResult } = input;

    if (toolResult.status !== "succeeded") {
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
  return `Evidence from ${toolResult.toolName}.`;
}

function getSensitivityFromMetadata(metadata: Metadata): EvidenceSensitivity {
  return metadata.sensitivity === "sensitive" ? "sensitive" : "normal";
}
