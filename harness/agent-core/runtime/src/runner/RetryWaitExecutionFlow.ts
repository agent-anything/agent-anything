import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";

export const RETRY_WAIT_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner: "agent-runtime", id: "retry-wait", revision: "1", label: "Retry Wait and Wake Admission",
  description: "Exact invocation-owned delay registration, timer delivery, suspension hold, and admitted continuation.",
  steps: [
    {id: "register", label: "Register exact pending wait", kind: "entry", checks: ["invocation_ownership"]},
    {id: "timer", label: "Arm and await timer", kind: "wait", checks: ["timer_delivery"]},
    {id: "admission", label: "Check wake admission", kind: "check", checks: ["interruption", "suspension", "current_basis"]},
    {id: "hold", label: "Retain readiness during suspension", kind: "wait", checks: []},
    {id: "settle", label: "Consume or invalidate wait", kind: "exit", checks: []},
  ],
  transitions: [["register","timer"],["register","settle"],["timer","admission"],["timer","settle"],["admission","hold"],["hold","admission"],["hold","settle"],["admission","settle"]].map(([from,to]) => ({id:`${from}:${to}`,from:from!,to:to!,label:`${from} to ${to}`})),
  entryStepIds: ["register"], exitStepIds: ["settle"],
});
