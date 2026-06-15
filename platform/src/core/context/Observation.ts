import type { EvidenceRef, Metadata } from "@agent-anything/shared";

export interface Observation {
  id: string;
  source: ObservationSource;
  summary: string;
  toolResultRef: string | null;
  evidenceRefs: EvidenceRef[];
  metadata: Metadata;
}

export interface ObservationSource {
  kind: "toolResult" | "system" | "planner";
  id: string;
  metadata: Metadata;
}
