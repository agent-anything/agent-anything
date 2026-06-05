import type { Evidence } from "../evidence/index.js";
import type { Report } from "../report/index.js";
import type { StoredArtifact } from "./StoredArtifact.js";

export interface StoragePort {
  storeReport(report: Report): Promise<StoredArtifact>;
  storeEvidence(evidence: Evidence): Promise<StoredArtifact>;
}
