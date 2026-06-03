import type { Metadata } from "../shared/types";

export type EvidenceSensitivity = "normal" | "sensitive";

export interface Evidence<TContent = unknown> {
  id: string;
  source: EvidenceSource;
  summary: string;
  content: TContent;
  sensitivity: EvidenceSensitivity;
  metadata: Metadata;
}

export interface EvidenceSource {
  kind: "toolResult";
  toolCallId: string;
  toolName: string;
  metadata?: Metadata;
}
