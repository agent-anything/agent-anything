import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";
export const DESCENDANT_TRANSFER_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner:"agent-runtime",id:"descendant-result-transfer",revision:"1",label:"Descendant Result Transfer",
  description:"Parent-owned consumption of a settled Child result, including resource accounting, projection and delivery. Child completion alone is not Parent consumption.",
  steps:[
    {id:"receive",label:"Receive Child terminal result",kind:"entry",checks:[]},
    {id:"account",label:"Settle Child resource account",kind:"call",checks:[]},
    {id:"project",label:"Construct delegated result",kind:"call",checks:["result_projection"]},
    {id:"retain",label:"Retain continuation and result",kind:"process",checks:[]},
    {id:"deliver",label:"Deliver to Parent processing",kind:"call",checks:[]},
    {id:"settle",label:"Settle transfer obligation",kind:"exit",checks:[]},
  ],
  transitions:[["receive","account"],["account","project"],["project","retain"],["retain","deliver"],["deliver","settle"]].map(([from,to])=>({id:`${from}:${to}`,from:from!,to:to!,label:`${from} to ${to}`})),entryStepIds:["receive"],exitStepIds:["settle"],
});
