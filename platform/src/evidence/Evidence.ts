import type { Metadata } from "../shared/types.js";
import type { EvidenceSource } from "./EvidenceSource.js";

export type EvidenceSensitivity = "public" | "private" | "secret" | "restricted";

export interface Evidence<TContent = unknown> {
  id: string;
  source: EvidenceSource;
  summary: string;
  content: TContent;
  sensitivity: EvidenceSensitivity;
  metadata: Metadata;
}
