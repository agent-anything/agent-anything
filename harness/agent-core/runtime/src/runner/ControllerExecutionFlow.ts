import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";

export const CONTROLLER_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner: "agent-runtime", id: "controller-execution", revision: "1", label: "Controller and Context",
  description: "Capture Tool Exposure, project Context, call the Controller, and validate the returned decision against its actual basis.",
  steps: [
    {id: "exposure", label: "Resolve Tool Exposure", kind: "entry", checks: ["basis_revision"]},
    {id: "context", label: "Project Controller Context", kind: "process", checks: ["projection_contract"]},
    {id: "controller", label: "Invoke Controller", kind: "call", checks: []},
    {id: "validity", label: "Recheck decision basis", kind: "check", checks: ["freshness"]},
    {id: "decision", label: "Validate and record decision", kind: "exit", checks: ["decision_contract"]},
  ],
  transitions: [["exposure","context"],["context","controller"],["controller","validity"],["validity","decision"]].map(([from,to]) => ({id:`${from}:${to}`,from:from!,to:to!,label:`${from} to ${to}`})),
  entryStepIds: ["exposure"], exitStepIds: ["decision"],
});
