import type { Evidence } from "@agent-anything/evidence";
import type { StoredArtifact } from "./StoredArtifact.js";

export interface StoragePort {
  storeEvidence(evidence: Evidence): Promise<StoredArtifact>;
}
