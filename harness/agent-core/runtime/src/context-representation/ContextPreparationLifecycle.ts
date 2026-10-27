import type { AgentActivityExecutionContext } from "../decision/TaskDecisionActivity.js";
/** Run-owned preparation recovery does not require a pending task decision. */
export interface ContextPreparationLifecycle {
  resume(runId: string, context: AgentActivityExecutionContext): Promise<void>;
}
