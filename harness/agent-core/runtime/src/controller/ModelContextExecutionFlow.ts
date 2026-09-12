import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";

export const MODEL_CONTEXT_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner: "agent-runtime", id: "model-context-admission", revision: "1", label: "Model Context Admission",
  description: "Measure the composed request, assess target capacity, optionally recover input, then admit or reject that exact request.",
  steps: [
    {id: "measure", label: "Measure input and assess capacity", kind: "entry", checks: ["capacity"]},
    {id: "recovery", label: "Recover and reassess model input", kind: "call", checks: ["recovery_capability", "recovery_result"]},
    {id: "result", label: "Return context admission", kind: "exit", checks: ["proven_overflow"]},
  ],
  transitions: [["measure","recovery"],["measure","result"],["recovery","result"]].map(([from,to])=>({id:`${from}:${to}`,from:from!,to:to!,label:`${from} to ${to}`})),
  entryStepIds: ["measure"], exitStepIds: ["result"],
});
