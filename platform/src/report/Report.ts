import type { EvidenceRef, ISODateTimeString, Metadata } from "../shared/types";

export interface Report {
  id: string;
  taskId: string;
  title: string;
  sections: ReportSection[];
  evidenceRefs: EvidenceRef[];
  createdAt: ISODateTimeString;
  metadata: Metadata;
}

export interface ReportSection {
  title: string;
  content: string;
  evidenceRefs: EvidenceRef[];
  metadata?: Metadata;
}
