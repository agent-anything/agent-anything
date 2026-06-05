import type { Metadata } from "../shared/types.js";

export interface EvidenceSource {
  kind: "toolResult";
  toolCallId: string;
  toolName: string;
  metadata?: Metadata;
}
