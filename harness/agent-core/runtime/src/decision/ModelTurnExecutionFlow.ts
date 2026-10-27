import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";
export const MODEL_TURN_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner: "agent-runtime", id: "model-turn", revision: "3", label: "Model Task Decision Coordination",
  description: "Coordinate Context Representation Manager, shared model access, and response interpretation without conflating their decisions.",
  steps: [
    {id:"build",label:"Build model input",kind:"entry",checks:["request_contract"]},
    {id:"send",label:"Prepare and bind input, then obtain response",kind:"call",checks:[]},
    {id:"parse",label:"Interpret response as typed decision",kind:"exit",checks:["output_complete","decision_contract"]},
  ],
  transitions: [["build","send"],["send","parse"],["parse","build"]].map(([from,to])=>({id:`${from}:${to}`,from:from!,to:to!,label:`${from} to ${to}`})),
  entryStepIds:["build"],exitStepIds:["parse"],
});
