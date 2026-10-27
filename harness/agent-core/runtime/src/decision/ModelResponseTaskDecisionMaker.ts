import type { ProviderResponse } from "@agent-anything/model-interaction";
import type { ExecutionFlowContext } from "@agent-anything/observability/execution-flow";
import type { TaskDecisionProposal, TaskDecisionInputSources } from "./TaskDecisionActivity.js";
import { TaskDecisionActivityError } from "./TaskDecisionActivityError.js";
import { StructuredOutputError } from "./StructuredOutput.js";
import { assertModelActivityRequest } from "../model-access/ModelActivityBinding.js";
import type { BoundTaskDecisionInput, TaskDecisionContext, TaskDecisionMaker } from "./TaskDecisionMaker.js";
import { assertModelDecisionProvenance, validateTaskDecisionProposal } from "./TaskDecisionValidation.js";
export type TaskResponseProtocol = {
  readonly kind: "structured_output";
  readonly contractId: string;
  readonly maxProviderOutputLength: number;
} | {
  readonly kind: "native_tool_turn";
  readonly maximumOutputRecoveryAttempts?: number;
};
export type InterpretTaskResponse<TOutput> = (response: ProviderResponse, source: TaskDecisionInputSources<TOutput>, executionFlow?: ExecutionFlowContext) => TaskDecisionProposal<TOutput> | Promise<TaskDecisionProposal<TOutput>>;
/** Interprets an already completed exchange. It cannot prepare input or call a Provider. */
export class ModelResponseTaskDecisionMaker<TOutput = unknown> implements TaskDecisionMaker<TOutput> {
  constructor(readonly protocol: TaskResponseProtocol, private readonly interpret: InterpretTaskResponse<TOutput>) { }
  async decide(input: BoundTaskDecisionInput<TOutput>, context: TaskDecisionContext): Promise<TaskDecisionProposal<TOutput>> {
    context.signal.throwIfAborted();
    if (input.kind !== "model_response" || input.activity.owner.kind !== "task_decision" ||
      input.activity.runId !== input.source.runId)
      throw new TypeError("Task interpretation requires its bound task response.");
    assertModelActivityRequest(input.activity, input.request);
    if (input.response.kind === "native_tool_turn" && input.response.turn.responseRef.requestId !== input.request.requestId) {
      throw new TypeError("Task response does not match its actual bound request.");
    }
    if (this.protocol.kind === "structured_output") {
      if (input.response.kind !== "structured_generation" || input.response.output === null || input.response.output === undefined) {
        throw protocolFailure("structured_output_schema", "structured_output_missing", "Return one value satisfying the active response contract.");
      }
      const output = typeof input.response.output === "string" ? input.response.output : JSON.stringify(input.response.output);
      if (output.length > this.protocol.maxProviderOutputLength) {
        throw protocolFailure("structured_output_size", "structured_output_too_large", "Return a shorter structured output within the configured output limit.");
      }
    }
    else if (input.response.kind !== "native_tool_turn" || input.response.turn.finish.kind === "output_limit") {
      throw new TypeError("An incomplete native response cannot produce a task decision.");
    }
    let proposal: TaskDecisionProposal<TOutput>;
    try {
      proposal = await this.interpret(input.response, input.source, context.executionFlow);
    }
    catch (error) {
      if (error instanceof TaskDecisionActivityError || error instanceof StructuredOutputError)
        throw error;
      throw new TaskDecisionActivityError({
        kind: "model", failure: {
          code: "model_output_invalid", message: "Provider output parsing failed.",
          retryable: false, metadata: { errorName: error instanceof Error ? error.name : "unknown" }
        }
      }, "settled_failure");
    }
    context.signal.throwIfAborted();
    const decision = validateTaskDecisionProposal(proposal, input.source);
    assertModelDecisionProvenance(decision, input.source.toolExposure.controllerRequestId);
    return decision;
  }
}
function protocolFailure(category: "structured_output_schema" | "structured_output_size", code: string, message: string): StructuredOutputError {
  return new StructuredOutputError({ category, code, correctionFeedback: message });
}
