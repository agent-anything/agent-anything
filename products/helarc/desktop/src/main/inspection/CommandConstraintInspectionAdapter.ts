import { createExecutionFlowDefinition, ExecutionFlowInvocation, type ExecutionFlowContext } from "@agent-anything/observability/execution-flow";
import type { CommandConstraintFact } from "@agent-anything/helarc-local-environment/command";

const definition = createExecutionFlowDefinition({owner: "helarc-command", id: "command-constraint-check", revision: "1",
  label: "Command constraint check", description: "One check recorded by the command owner, with its actual input, binding and scope.",
  steps: [{id: "check", label: "Apply command constraint", kind: "check", checks: ["preparation", "capacity", "deadline", "execution_deadline"]}],
  transitions: [], entryStepIds: ["check"], exitStepIds: ["check"]});

export class CommandConstraintInspectionAdapter {
  constructor(private readonly context: ExecutionFlowContext) {}
  observe = (fact: CommandConstraintFact): void => {
    const subjects = [{owner: "action-execution", kind: "action", id: fact.actionId, revision: null},
      ...(fact.invocationId ? [{owner: "operations", kind: "operation", id: fact.invocationId, revision: null}] : []),
      ...(fact.executionId ? [{owner: "helarc-command", kind: "process", id: fact.executionId, revision: null}] : [])];
    const flow = new ExecutionFlowInvocation(definition, this.context, fact.runId, subjects, () => fact.occurredAt);
    const material = flow.material("Command constraint facts", fact.stage, fact, "execution");
    const step = flow.enter("check", {inputs: subjects, basis: {stage: fact.stage, managerId: fact.managerId}});
    step.check(fact.stage, fact.status, fact.basis, {...fact.configuration, runId: null});
    step.end("returned", {status: fact.status}, null, [material]);
    flow.close("returned", step.ref, [material]);
  };
}
