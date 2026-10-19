import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";
export const HELARC_REQUEST_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner:"helarc",id:"model-input-composition",revision:"1",label:"Helarc Model Input",
  description:"Current optional instructions, complete callable definitions, conversation, and Context assembled for this exact model request.",
  steps:[{id:"compose",label:"Compose Helarc model input",kind:"entry",checks:["instruction_binding","settled_interaction"]},{id:"request",label:"Return Provider request",kind:"exit",checks:[]}],
  transitions:[{id:"compose:request",from:"compose",to:"request",label:"Composed request"}],entryStepIds:["compose"],exitStepIds:["request"],
});
export const HELARC_RESPONSE_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner:"helarc",id:"model-response-interpretation",revision:"2",label:"Helarc Response Interpretation",
  description:"Resolve callable bindings or a normal final response into the typed decision protocol; not a task-success assessment.",
  steps:[{id:"interpret",label:"Interpret native model response",kind:"entry",checks:[]},
    {id:"reply_resolution",label:"Bind resolved final reply",kind:"process",checks:[]},
    {id:"decision",label:"Return typed decision",kind:"exit",checks:[]}],
  transitions:[{id:"interpret:decision",from:"interpret",to:"decision",label:"Typed decision"},
    {id:"interpret:reply_resolution",from:"interpret",to:"reply_resolution",label:"Final reply selection"},
    {id:"reply_resolution:decision",from:"reply_resolution",to:"decision",label:"Ending candidate"}],entryStepIds:["interpret"],exitStepIds:["decision"],
});
