

export interface EvidenceSource {
  kind: "toolResult";
  toolCallId: string;
  toolName: string;
  metadata?: Readonly<Record<string, unknown>>;
}
