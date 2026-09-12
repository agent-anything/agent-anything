import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";

export const HELARC_STOP_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner: "helarc", id: "stop-instructions", revision: "1", label: "Helarc Stop Instructions",
  description: "Optional Product completion feedback. Empty effective instructions allow without making a model request.",
  steps: [
    {id:"instructions",label:"Resolve effective Stop Instructions",kind:"entry",checks:["effective_instructions"]},
    {id:"request",label:"Build and send optional assessment",kind:"call",checks:[]},
    {id:"assessment",label:"Interpret Product assessment",kind:"process",checks:[]},
    {id:"decision",label:"Return Hook disposition",kind:"exit",checks:[]},
  ],
  transitions: [["instructions","request"],["instructions","decision"],["request","assessment"],["assessment","decision"]].map(([from,to])=>({id:`${from}:${to}`,from:from!,to:to!,label:`${from} to ${to}`})),
  entryStepIds:["instructions"],exitStepIds:["decision"],
});
