import type { ArtifactRef, EvidenceRef, Metadata } from "../../shared/types.js";
import type { RuntimeError } from "./RuntimeError.js";

export type RuntimeStatus = "succeeded" | "failed" | "blocked" | "cancelled";

export interface RuntimeResult {
  taskId: string;
  status: RuntimeStatus;
  reportRef: ArtifactRef | null;
  evidenceRefs: EvidenceRef[];
  artifactRefs: ArtifactRef[];
  errors: RuntimeError[];
  metadata: Metadata;
}
