import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";

export const RUN_CONTROL_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner:"agent-runtime", id:"run-control", revision:"1", label:"Run Control Admission",
  description:"Exact trusted suspend/resume request processing. An observation is never a control submission.",
  steps:[
    {id:"receive",label:"Receive targeted request",kind:"entry",checks:[]},
    {id:"admit",label:"Validate and apply control",kind:"check",checks:["control_admission"]},
    {id:"receipt",label:"Return authoritative receipt",kind:"exit",checks:[]},
  ],
  transitions:[{id:"receive:admit",from:"receive",to:"admit",label:"Validate"},{id:"admit:receipt",from:"admit",to:"receipt",label:"Return receipt"}],entryStepIds:["receive"],exitStepIds:["receipt"],
});
export const RUN_SUSPENSION_WAIT_FLOW = createExecutionFlowDefinition({
  owner:"agent-runtime",id:"suspension-wait",revision:"1",label:"Suspension Hold",
  description:"The executing branch waits for accepted resume, cancellation, or its original deadline. Other changes do not release suspension.",
  steps:[{id:"wait",label:"Hold branch at suspension",kind:"wait",checks:[]},{id:"released",label:"Return to Core control checks",kind:"exit",checks:["release_source"]}],
  transitions:[{id:"wait:released",from:"wait",to:"released",label:"Explicit control or interruption"}],entryStepIds:["wait"],exitStepIds:["released"],
});
