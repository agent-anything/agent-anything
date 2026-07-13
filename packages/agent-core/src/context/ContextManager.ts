import type { AgentTask } from "../task/index.js";
import type { ContextSnapshot } from "./ContextSnapshot.js";
import type { LegacyContextUpdate } from "./ContextUpdate.js";

export interface ContextManager {
  createInitial(task: AgentTask): Promise<ContextSnapshot>;
  getSnapshot(taskId: string): Promise<ContextSnapshot>;
  applyUpdate(update: LegacyContextUpdate): Promise<ContextSnapshot>;
}
