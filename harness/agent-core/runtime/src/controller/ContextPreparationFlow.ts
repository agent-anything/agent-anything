import {createExecutionFlowDefinition} from "@agent-anything/observability/execution-flow";

export const CONTEXT_PREPARATION_FLOW = createExecutionFlowDefinition({
  owner: "agent-runtime", id: "context-preparation", revision: "1", label: "Context Preparation",
  description: "Independent preparation, conditional Run view selection and exact request freeze. None of these facts acknowledges input delivery.",
  steps: [
    {id: "register", label: "Register preparation", kind: "entry", checks: ["current_basis"]},
    {id: "prepare", label: "Prepare retained owner forms", kind: "call", checks: ["preservation"]},
    {id: "select", label: "Select working view", kind: "check", checks: ["predecessor_and_authority"]},
    {id: "freeze", label: "Freeze working input", kind: "call", checks: ["unchanged_pending_batch"]},
    {id: "retire", label: "Close preparation producer", kind: "exit", checks: ["durable_retirement"]},
  ],
  transitions: [["register", "prepare"], ["prepare", "select"], ["select", "freeze"], ["freeze", "retire"]]
    .map(([from, to]) => ({id: `${from}:${to}`, from: from!, to: to!, label: `${from} to ${to}`})),
  entryStepIds: ["register"], exitStepIds: ["retire"],
});

export const CONTEXT_DISPATCH_FLOW = createExecutionFlowDefinition({
  owner: "agent-runtime", id: "context-dispatch-binding", revision: "1", label: "Context Request Binding",
  description: "Bind the final Provider envelope to the selected context before dispatch. Response and Turn acceptance remain separate facts.",
  steps: [{id: "bind", label: "Freeze Provider envelope", kind: "entry", checks: ["selected_view_and_authority"]},
    {id: "ready", label: "Request bound", kind: "exit", checks: []}],
  transitions: [{id: "bind:ready", from: "bind", to: "ready", label: "Binding committed"}], entryStepIds: ["bind"], exitStepIds: ["ready"],
});
