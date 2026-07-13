import type { EvidenceRef, Metadata } from "@agent-anything/shared";
import type { ContextMessage } from "./ContextMessage.js";
import type { Observation } from "./Observation.js";

export interface LegacyContextUpdate {
  taskId: string;
  observations?: Observation[];
  evidenceRefs?: EvidenceRef[];
  messages?: ContextMessage[];
  metadata?: Metadata;
}
