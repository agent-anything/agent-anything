import type { Metadata } from "@agent-anything/shared";
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
