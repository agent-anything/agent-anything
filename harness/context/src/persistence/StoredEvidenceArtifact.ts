import type {
  ArtifactRef,
  EvidenceRef,
  ISODateTimeString,
  Metadata,
} from "@agent-anything/foundation";

export interface StoredEvidenceArtifact {
  readonly storageId: string;
  readonly evidenceRef: EvidenceRef;
  readonly artifactRef: ArtifactRef;
  readonly createdAt: ISODateTimeString;
  readonly metadata: Metadata;
}
