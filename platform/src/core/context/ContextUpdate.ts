import type { EvidenceRef, Metadata } from "../../shared/types.js";
import type { ContextMessage } from "./ContextMessage.js";
import type { Observation } from "./Observation.js";

export interface ContextUpdate {
  taskId: string;
  observations?: Observation[];
  evidenceRefs?: EvidenceRef[];
  messages?: ContextMessage[];
  metadata?: Metadata;
}
