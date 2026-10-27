import type { ExecutionFlowContext } from "@agent-anything/observability/execution-flow";
import type { ProviderRequest, ProviderResponse } from "@agent-anything/model-interaction";
import type { TaskDecisionProposal, TaskDecisionInputSources } from "./TaskDecisionActivity.js";
import type { ModelActivityBinding } from "../model-access/ModelActivityBinding.js";
export type BoundTaskDecisionInput<TOutput = unknown> = {
  readonly source: TaskDecisionInputSources<TOutput>;
} & ({
  readonly kind: "direct";
  readonly bindingId: string;
} | {
  readonly kind: "model_response";
  readonly activity: ModelActivityBinding;
  readonly request: ProviderRequest;
  readonly response: ProviderResponse;
});
export interface TaskDecisionContext {
  readonly signal: AbortSignal;
  readonly executionFlow?: ExecutionFlowContext;
}
/** No preparation, transport, execution, persistence or permission-granting ports. */
export interface TaskDecisionMaker<TOutput = unknown> {
  decide(input: BoundTaskDecisionInput<TOutput>, context: TaskDecisionContext): Promise<TaskDecisionProposal<TOutput>>;
}
