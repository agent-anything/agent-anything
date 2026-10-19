import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";

export const COMPOSITE_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner:"operation-composition",id:"composite-execution",revision:"3",label:"Composite Execution",
  description:"Evaluate explicit node prerequisites, select a safe execution wave, drain its branches and reduce recorded settlements.",
  steps:[
    {id:"recover",label:"Restore retained graph and reconcile admitted nodes",kind:"entry",checks:["reconciliation"]},
    {id:"eligibility",label:"Evaluate dependency eligibility",kind:"entry",checks:[]},
    {id:"schedule",label:"Select execution wave",kind:"check",checks:["resource_conflict"]},
    {id:"dispatch",label:"Dispatch selected branches",kind:"call",checks:[]},
    {id:"join",label:"Drain wave settlements",kind:"wait",checks:[]},
    {id:"reduce",label:"Construct public aggregate result",kind:"exit",checks:["aggregate_preserved","result_construction"]},
  ],
  transitions:[["recover","eligibility"],["recover","reduce"],["eligibility","schedule"],["eligibility","reduce"],["schedule","dispatch"],["schedule","reduce"],["dispatch","join"],["join","eligibility"],["join","reduce"]].map(([from,to])=>({id:`${from}:${to}`,from:from!,to:to!,label:`${from} to ${to}`})),
  entryStepIds:["eligibility","recover"],exitStepIds:["reduce","recover"],
});
export const COMPOSITE_NODE_FLOW = createExecutionFlowDefinition({
  owner:"operation-composition",id:"composite-node",revision:"1",label:"Composite Node",
  description:"A declared node's exact prerequisites and condition, transform, child dispatch and settlement.",
  steps:[
    {id:"dependencies",label:"Check declared prerequisites",kind:"entry",checks:["dependencies_settled","dependencies_succeeded","condition"]},
    {id:"transform",label:"Transform node input",kind:"process",checks:[]},
    {id:"execute",label:"Execute node operation",kind:"call",checks:[]},
    {id:"settle",label:"Commit node settlement",kind:"exit",checks:[]},
  ],
  transitions:[["dependencies","dependencies"],["dependencies","transform"],["dependencies","settle"],["transform","execute"],["transform","settle"],["execute","settle"]].map(([from,to])=>({id:`${from}:${to}`,from:from!,to:to!,label:`${from} to ${to}`})),
  entryStepIds:["dependencies"],exitStepIds:["settle"],
});
