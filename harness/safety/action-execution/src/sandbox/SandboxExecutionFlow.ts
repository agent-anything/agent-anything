import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";

export const SANDBOX_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner: "action-execution", id: "sandbox-dispatch", revision: "1", label: "Sandbox and Executor Dispatch",
  description: "Qualify the exact physical attempt, select enforcement, dispatch and validate its recorded outcome. External execution remains opaque.",
  steps: [
    {id:"qualify",label:"Qualify physical attempt",kind:"entry",checks:["unique_attempt","executor","request","provider"]},
    {id:"enforcement",label:"Select enforcement",kind:"check",checks:["supported_policy"]},
    {id:"secrets",label:"Resolve required secrets",kind:"call",checks:["secret_references"]},
    {id:"dispatch",label:"Dispatch to executor or sandbox provider",kind:"call",checks:[]},
    {id:"validate",label:"Validate physical outcome",kind:"check",checks:["physical_outcome"]},
    {id:"result",label:"Return sandbox outcome",kind:"exit",checks:[]},
  ],
  transitions: [["qualify","enforcement"],["qualify","result"],["enforcement","secrets"],["enforcement","dispatch"],["enforcement","result"],["secrets","dispatch"],["secrets","result"],["dispatch","validate"],["dispatch","result"],["validate","result"]].map(([from,to])=>({id:`${from}:${to}`,from:from!,to:to!,label:`${from} to ${to}`})),
  entryStepIds:["qualify"],exitStepIds:["result"],
});
