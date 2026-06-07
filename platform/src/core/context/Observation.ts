import type { EvidenceRef, Metadata } from "../../shared/types.js";

export interface Observation {
  id: string;
  source: ObservationSource;
  summary: string;
  toolResultRef: string | null;
  evidenceRefs: EvidenceRef[];
  metadata: Metadata;
}

export interface ObservationSource {
  kind: "toolResult" | "runtime" | "planner";
  id: string;
  metadata: Metadata;
}
