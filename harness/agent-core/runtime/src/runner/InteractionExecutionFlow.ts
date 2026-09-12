import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";

export const INTERACTION_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner: "agent-runtime", id: "interaction-coordination", revision: "1",
  label: "Interaction Coordination",
  description: "Exact request admission, external submission, protocol resolution, application and terminal delivery.",
  steps: [
    {id: "open", label: "Admit Interaction request", kind: "entry", checks: ["run_open", "protocol", "unique_request"]},
    {id: "wait", label: "Await submission", kind: "wait", checks: ["submission_receipt"]},
    {id: "resolve", label: "Validate and resolve submission", kind: "call", checks: ["submission_contract"]},
    {id: "apply", label: "Apply protocol resolution", kind: "call", checks: []},
    {id: "settle", label: "Deliver Interaction settlement", kind: "exit", checks: ["terminal_commit"]},
  ],
  transitions: [["open","wait"],["open","settle"],["wait","resolve"],["wait","settle"],["resolve","apply"],["resolve","settle"],["apply","settle"]].map(([from,to])=>({id:`${from}:${to}`,from:from!,to:to!,label:`${from} to ${to}`})),
  entryStepIds: ["open"], exitStepIds: ["settle"],
});
