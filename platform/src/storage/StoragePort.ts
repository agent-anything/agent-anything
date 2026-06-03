import type { Evidence } from "../evidence";
import type { Report } from "../report";
import type { StoredArtifact } from "./StoredArtifact";

export interface StoragePort {
  storeReport(report: Report): Promise<StoredArtifact>;
  storeEvidence(evidence: Evidence): Promise<StoredArtifact>;
}
