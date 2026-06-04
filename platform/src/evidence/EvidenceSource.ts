import type { Metadata } from "../shared/types";

export interface EvidenceSource {
  kind: "toolResult";
  toolCallId: string;
  toolName: string;
  metadata?: Metadata;
}
