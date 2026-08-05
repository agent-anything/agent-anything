
import type { Evidence } from "../evidence/Evidence.js";
import type { StoredEvidenceArtifact } from "./StoredEvidenceArtifact.js";

export interface EvidencePersistenceError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type EvidencePersistenceResult =
  | {
      readonly status: "stored";
      readonly artifact: StoredEvidenceArtifact;
    }
  | {
      readonly status: "failed";
      readonly error: EvidencePersistenceError;
    };

export interface EvidencePersistencePort {
  persistEvidence(evidence: Evidence): Promise<EvidencePersistenceResult>;
}
