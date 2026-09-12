import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";
export const HELARC_RESULT_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner:"helarc",id:"result-delivery",revision:"1",label:"Helarc Result Delivery",
  description:"Map settled Run facts into the Product result and publish the Product projection. Does not reinterpret normal completion as task success.",
  steps:[{id:"result",label:"Receive settled Run result",kind:"entry",checks:[]},{id:"project",label:"Project Product result",kind:"process",checks:[]},{id:"deliver",label:"Publish Product projection",kind:"exit",checks:[]}],
  transitions:[{id:"result:project",from:"result",to:"project",label:"Project"},{id:"project:deliver",from:"project",to:"deliver",label:"Publish"}],entryStepIds:["result"],exitStepIds:["deliver"],
});
