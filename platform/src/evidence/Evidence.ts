import type { Metadata } from "../shared/types.js";
import type { EvidenceSource } from "./EvidenceSource.js";

export type EvidenceSensitivity = "normal" | "sensitive";

export interface Evidence<TContent = unknown> {
  id: string;
  source: EvidenceSource;
  summary: string;
  content: TContent;
  sensitivity: EvidenceSensitivity;
  metadata: Metadata;
}
