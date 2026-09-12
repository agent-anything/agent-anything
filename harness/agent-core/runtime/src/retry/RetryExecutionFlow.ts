import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";
export const RETRY_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner: "agent-runtime", id: "retry-execution", revision: "1", label: "Technical Request Retry",
  description: "Owner-classified attempts with one cumulative budget and deadline. No generic Tool replay.",
  steps: [
    {id:"attempt",label:"Execute one Attempt",kind:"call",checks:["cancellation","deadline"]},
    {id:"classify",label:"Classify Attempt outcome",kind:"check",checks:["failure_classification"]},
    {id:"budget",label:"Resolve Retry allowance",kind:"branch",checks:["initial_allowance","recovery_allowance"]},
    {id:"wait",label:"Await registered Retry delay",kind:"call",checks:[]},
    {id:"settled",label:"Return operation outcome",kind:"exit",checks:[]},
  ],
  transitions: [["attempt","classify"],["attempt","settled"],["classify","budget"],["classify","settled"],["budget","wait"],["budget","settled"],["wait","attempt"],["wait","settled"]].map(([from,to])=>({id:`${from}:${to}`,from:from!,to:to!,label:`${from} to ${to}`})),
  entryStepIds:["attempt","settled"],exitStepIds:["settled"],
});
