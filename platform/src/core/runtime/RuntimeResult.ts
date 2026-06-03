import type { ArtifactRef, EvidenceRef, Metadata } from "../../shared/types";
import type { RuntimeError } from "./RuntimeError";

export type RuntimeStatus = "succeeded" | "failed";

export interface RuntimeResult {
  taskId: string;
  status: RuntimeStatus;
  reportRef: ArtifactRef | null;
  evidenceRefs: EvidenceRef[];
  artifactRefs: ArtifactRef[];
  errors: RuntimeError[];
  metadata: Metadata;
}
