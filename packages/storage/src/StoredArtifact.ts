import type { ArtifactRef, ISODateTimeString, Metadata } from "@agent-anything/shared";

export type StoredArtifactKind = "evidence";

export interface StoredArtifact {
  id: string;
  kind: StoredArtifactKind;
  ref: ArtifactRef;
  createdAt: ISODateTimeString;
  metadata: Metadata;
}
