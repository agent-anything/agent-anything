import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";
export const AGENT_HOOK_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner:"agent-hooks",id:"agent-stop-dispatch",revision:"1",label:"Optional Agent Stop Handling",
  description:"Agent-layer Controller decoration. Core completion does not depend on registered Hooks.",
  steps:[
    {id:"controller",label:"Call underlying Controller",kind:"entry",checks:[]},
    {id:"candidate",label:"Inspect returned decision",kind:"check",checks:["normal_completion","registered_handlers","continuation_allowance"]},
    {id:"handlers",label:"Dispatch matching Stop Handlers",kind:"call",checks:[]},
    {id:"failure",label:"Dispatch StopFailure observers",kind:"call",checks:[]},
    {id:"result",label:"Return typed decision",kind:"exit",checks:[]},
  ],
  transitions:[["controller","candidate"],["controller","failure"],["failure","result"],["candidate","handlers"],["candidate","result"],["handlers","result"]].map(([from,to])=>({id:`${from}:${to}`,from:from!,to:to!,label:`${from} to ${to}`})),
  entryStepIds:["controller"],exitStepIds:["result"],
});
export const AGENT_HOOK_HANDLER_FLOW = createExecutionFlowDefinition({
  owner:"agent-hooks",id:"hook-handler",revision:"1",label:"Agent Hook Handler",
  description:"One registered Handler with bounded interruption, timeout, and result validation.",
  steps:[{id:"invoke",label:"Invoke registered Handler",kind:"entry",checks:[]},{id:"settle",label:"Record Handler outcome",kind:"exit",checks:["result_contract"]}],
  transitions:[{id:"invoke:settle",from:"invoke",to:"settle",label:"Handler returned or bounded"}],entryStepIds:["invoke"],exitStepIds:["settle"],
});
