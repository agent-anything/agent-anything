import type { Evidence } from "../evidence/index.js";
import type { StoredArtifact } from "./StoredArtifact.js";

export interface StoragePort {
  storeEvidence(evidence: Evidence): Promise<StoredArtifact>;
}
