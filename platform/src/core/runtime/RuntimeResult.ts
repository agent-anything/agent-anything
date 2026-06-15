import type { ArtifactRef, EvidenceRef, Metadata } from "@agent-anything/shared";
import type { RuntimeError } from "./RuntimeError.js";

export type RuntimeStatus = "succeeded" | "failed" | "blocked" | "cancelled";

export interface RuntimeOutputSpec {
  format: "json";
  schema?: unknown;
  metadata: Metadata;
}

export interface RuntimeResult<TOutput = unknown> {
  taskId: string;
  status: RuntimeStatus;
  output: TOutput | null;
  outputSpec: RuntimeOutputSpec;
  evidenceRefs: EvidenceRef[];
  artifactRefs: ArtifactRef[];
  errors: RuntimeError[];
  metadata: Metadata;
}
