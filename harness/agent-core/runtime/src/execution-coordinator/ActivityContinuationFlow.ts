import { createExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";
export const ACTIVITY_CONTINUATION_FLOW = createExecutionFlowDefinition({
  owner: "agent-runtime", id: "activity-continuation", revision: "1", label: "Activity Continuation",
  description: "Accept an attributed correction or capacity recovery without claiming task work or input adoption.",
  steps: [
    { id: "basis", label: "Receive continuation basis", kind: "entry", checks: ["activity_and_allowance"] },
    { id: "accepted", label: "Accept continuation arrangement", kind: "exit", checks: [] },
  ],
  transitions: [{ id: "accept", from: "basis", to: "accepted", label: "Current conditions allow continuation" }],
  entryStepIds: ["basis"], exitStepIds: ["accepted"],
});
