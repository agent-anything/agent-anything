import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";
export const MODEL_TURN_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner: "agent-runtime", id: "model-turn", revision: "1", label: "Provider-backed Model Turn",
  description: "Product input composition, model-context admission, technical Provider requests, and typed response interpretation.",
  steps: [
    {id:"build",label:"Build model input",kind:"entry",checks:["request_contract"]},
    {id:"send",label:"Admit model context and send request",kind:"call",checks:[]},
    {id:"parse",label:"Interpret response as typed decision",kind:"exit",checks:["decision_contract"]},
  ],
  transitions: [["build","send"],["send","parse"],["parse","build"]].map(([from,to])=>({id:`${from}:${to}`,from:from!,to:to!,label:`${from} to ${to}`})),
  entryStepIds:["build"],exitStepIds:["parse"],
});
