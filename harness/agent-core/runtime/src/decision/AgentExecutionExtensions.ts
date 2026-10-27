import type { AgentActivityExecutionContext, RunCompletionDisposition, RunCompletionCandidate, TaskDecisionProposal, TaskDecisionInputSources } from "./TaskDecisionActivity.js";
/** Optional execution-boundary logic, independent of task judgment and preparation. */
export interface AgentExecutionExtensions<T = unknown> {
  afterDecision?(input: TaskDecisionInputSources<T>, decision: TaskDecisionProposal<T>, context: AgentActivityExecutionContext): Promise<void>;
  onDecisionFailure?(input: TaskDecisionInputSources<T>, error: unknown, context: AgentActivityExecutionContext): Promise<void>;
  beforeCompletion?(input: RunCompletionCandidate<T>, context: AgentActivityExecutionContext): Promise<RunCompletionDisposition>;
  recoverBeforeCompletion?(input: RunCompletionCandidate<T>, context: AgentActivityExecutionContext): Promise<RunCompletionDisposition>;
}
