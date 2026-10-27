import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";
export const MODEL_ACCESS_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner: "agent-runtime", id: "model-activity-access", revision: "1", label: "Model Activity Access",
  description: "Bind an accepted activity to an exact request, execute transport attempts, and return only to that activity.",
  steps: [
    { id: "binding", label: "Bind activity and input owner", kind: "entry", checks: ["activity_scope"] },
    { id: "request", label: "Execute Provider attempts", kind: "call", checks: [] },
    { id: "result", label: "Return to the originating activity", kind: "exit", checks: [] },
  ],
  transitions: [
    { id: "dispatch", from: "binding", to: "request", label: "Accepted binding" },
    { id: "return", from: "request", to: "result", label: "Transport outcome" },
  ], entryStepIds: ["binding"], exitStepIds: ["result"],
});
