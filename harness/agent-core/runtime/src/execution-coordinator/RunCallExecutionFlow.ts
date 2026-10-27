import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";
export const RUN_CALL_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner:"agent-runtime",id:"model-call-execution",revision:"1",label:"Model Call Execution",
  description:"One captured Model Call materialized as a RunAction, executed through its owner, and returned to Model Interaction.",
  steps:[
    {id:"admission",label:"Materialize admitted Call",kind:"entry",checks:["admission"]},
    {id:"execute",label:"Execute typed candidate",kind:"call",checks:[]},
    {id:"observation",label:"Commit owner result",kind:"process",checks:[]},
    {id:"settlement",label:"Commit Model Call settlement",kind:"exit",checks:["single_settlement"]},
  ],
  transitions:[["admission","execute"],["execute","observation"],["execute","settlement"],["observation","observation"],["observation","settlement"]].map(([from,to])=>({id:`${from}:${to}`,from:from!,to:to!,label:`${from} to ${to}`})),
  entryStepIds:["admission"],exitStepIds:["settlement"],
});
export const OPERATION_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner:"agent-runtime",id:"operation-dispatch",revision:"1",label:"Operation Dispatch",
  description:"Resolve registered semantics and a trusted binding; dispatch to the actual implementation and preserve its result.",
  steps:[
    {id:"registration",label:"Check registration and origin",kind:"entry",checks:["registration","origin"]},
    {id:"binding",label:"Resolve operation binding",kind:"call",checks:["binding"]},
    {id:"execute",label:"Execute resolved binding",kind:"call",checks:[]},
    {id:"result",label:"Return Operation Result",kind:"exit",checks:[]},
  ],
  transitions:[["registration","binding"],["registration","result"],["binding","execute"],["binding","result"],["execute","result"]].map(([from,to])=>({id:`${from}:${to}`,from:from!,to:to!,label:`${from} to ${to}`})),
  entryStepIds:["registration"],exitStepIds:["result"],
});
