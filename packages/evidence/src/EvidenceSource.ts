import type { Metadata } from "@agent-anything/shared";

export interface EvidenceSource {
  kind: "toolResult";
  toolCallId: string;
  toolName: string;
  metadata?: Metadata;
}
