import type { EvidenceRef, ISODateTimeString, Metadata } from "../shared/types";
import type { ReportSection } from "./ReportSection";

export interface Report {
  id: string;
  taskId: string;
  title: string;
  sections: ReportSection[];
  evidenceRefs: EvidenceRef[];
  createdAt: ISODateTimeString;
  metadata: Metadata;
}
