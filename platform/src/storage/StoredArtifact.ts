import type { ArtifactRef, ISODateTimeString, Metadata } from "../shared/types.js";

export type StoredArtifactKind = "report" | "evidence";

export interface StoredArtifact {
  id: string;
  kind: StoredArtifactKind;
  ref: ArtifactRef;
  createdAt: ISODateTimeString;
  metadata: Metadata;
}
