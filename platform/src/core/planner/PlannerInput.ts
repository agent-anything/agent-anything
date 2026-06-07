import type { AgentTask } from "../task/index.js";
import type { ContextSnapshot } from "../context/index.js";
import type { Metadata } from "../../shared/types.js";

export interface PlannerInput {
  task: AgentTask;
  context: ContextSnapshot;
  metadata: Metadata;
}
