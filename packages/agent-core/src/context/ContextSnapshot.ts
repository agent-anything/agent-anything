import type { EvidenceRef, Metadata } from "@agent-anything/shared";
import type { ContextMessage } from "./ContextMessage.js";
import type { Observation } from "./Observation.js";

export interface ContextSnapshot {
  taskId: string;
  messages: ContextMessage[];
  observations: Observation[];
  evidenceRefs: EvidenceRef[];
  metadata: Metadata;
}
