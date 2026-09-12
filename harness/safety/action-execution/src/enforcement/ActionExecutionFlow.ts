import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";
const steps = [
  {id:"prepare",label:"Prepare canonical Action",kind:"entry",checks:["adapter","prepared_subject"]},
  {id:"policy",label:"Evaluate Governance Policy",kind:"call",checks:["policy"]},
  {id:"permission",label:"Assess Permission",kind:"call",checks:["permission"]},
  {id:"approval",label:"Await exact Approval",kind:"wait",checks:["approval"]},
  {id:"revalidate",label:"Revalidate subject and authority",kind:"check",checks:["baseline","authority"]},
  {id:"record",label:"Record pre-effect intent",kind:"process",checks:[]},
  {id:"sandbox",label:"Dispatch through Sandbox and Executor",kind:"call",checks:["progression_basis","authority_basis"]},
  {id:"retry",label:"Assess authorized physical retry",kind:"check",checks:["replay_basis"]},
  {id:"retry_wait",label:"Await physical retry delay",kind:"wait",checks:[]},
  {id:"settlement",label:"Record settlement and semantic result",kind:"exit",checks:[]},
] as const;
export const ACTION_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner:"action-execution",id:"canonical-action-execution",revision:"1",label:"Canonical Action Execution",
  description:"Actual preparation, authorization, revalidation, Sandbox dispatch, and physical settlement. Physical retry requires explicit replay evidence.",steps,
  transitions: [...[["prepare","policy"],["policy","permission"],["permission","approval"],["approval","permission"],["permission","revalidate"],["revalidate","record"],["record","sandbox"],["sandbox","retry"],["retry","retry_wait"],["retry_wait","revalidate"]], ...steps.filter(step=>step.id!=="settlement").map(step=>[step.id,"settlement"])].map(([from,to])=>({id:`${from}:${to}`,from:from!,to:to!,label:`${from} to ${to}`})),
  entryStepIds:["prepare"],exitStepIds:["settlement"],
});
