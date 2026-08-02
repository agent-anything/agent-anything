import type { Metadata } from "@agent-anything/foundation";

export interface EvidenceSource {
  kind: "toolResult";
  toolCallId: string;
  toolName: string;
  metadata?: Metadata;
}
