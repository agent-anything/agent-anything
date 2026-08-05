import type { ArtifactRef } from "@agent-anything/agent-core/run";
import type { EvidenceRef } from "../evidence/EvidenceRef.js";

export interface StoredEvidenceArtifact {
  readonly storageId: string;
  readonly evidenceRef: EvidenceRef;
  readonly artifactRef: ArtifactRef;
  readonly createdAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}
