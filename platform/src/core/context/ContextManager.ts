import type { AgentTask } from "../task/index.js";
import type { ContextSnapshot } from "./ContextSnapshot.js";
import type { ContextUpdate } from "./ContextUpdate.js";

export interface ContextManager {
  createInitial(task: AgentTask): Promise<ContextSnapshot>;
  getSnapshot(taskId: string): Promise<ContextSnapshot>;
  applyUpdate(update: ContextUpdate): Promise<ContextSnapshot>;
}
