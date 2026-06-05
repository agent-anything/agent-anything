import type { EvidenceRef, ISODateTimeString, Metadata } from "../shared/types.js";
import type { ReportSection } from "./ReportSection.js";

export interface Report {
  id: string;
  taskId: string;
  title: string;
  sections: ReportSection[];
  evidenceRefs: EvidenceRef[];
  createdAt: ISODateTimeString;
  metadata: Metadata;
}
