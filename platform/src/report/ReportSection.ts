import type { EvidenceRef, Metadata } from "../shared/types.js";

export interface ReportSection {
  title: string;
  content: string;
  evidenceRefs: EvidenceRef[];
  metadata?: Metadata;
}
