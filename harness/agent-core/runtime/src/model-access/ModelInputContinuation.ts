import { createExecutionFlowDefinition, ExecutionFlowPath, type ExecutionFlowContext } from "@agent-anything/observability/execution-flow";
import type { ProviderRequest } from "@agent-anything/model-interaction";

export interface AcceptedActivityContinuationRef {
  readonly id: string;
  readonly runId: string;
  readonly sourceRequestId: string;
}

const CONTINUED_INPUT_FLOW = createExecutionFlowDefinition({
  owner: "agent-runtime", id: "continued-model-input", revision: "1", label: "Continued Model Input",
  description: "Associate an accepted continuation with its newly composed input, without claiming dispatch or task adoption.",
  steps: [
    { id: "basis", label: "Accepted continuation", kind: "entry", checks: [] },
    { id: "input", label: "New input composed", kind: "exit", checks: [] },
  ],
  transitions: [{ id: "compose", from: "basis", to: "input", label: "Compose for accepted continuation" }],
  entryStepIds: ["basis"], exitStepIds: ["input"],
});

export function recordContinuedModelInput(accepted: AcceptedActivityContinuationRef, request: ProviderRequest, context?: ExecutionFlowContext): void {
  const basis = { owner: "agent-runtime", kind: "contribution", id: accepted.id, revision: "1" };
  const input = { owner: "model-interaction", kind: "request", id: request.requestId, revision: null };
  const flow = new ExecutionFlowPath(CONTINUED_INPUT_FLOW, context ?? {}, accepted.runId, [basis]);
  flow.advance("basis", { sourceRequestId: accepted.sourceRequestId }, [basis]);
  flow.advance("input", { requestId: request.requestId, compositionId: request.composition.id }, [basis]).output(input);
  flow.close("returned");
}
