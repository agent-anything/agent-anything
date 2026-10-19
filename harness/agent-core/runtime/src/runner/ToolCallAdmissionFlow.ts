import { admitToolCall, type ToolCallAdmissionInput } from "@agent-anything/tools/invocation";
import { createExecutionFlowDefinition, ExecutionFlowInvocation, type ExecutionFlowContext } from "@agent-anything/observability/execution-flow";

const definition = createExecutionFlowDefinition({owner: "tools", id: "tool-input-admission", revision: "1",
  label: "Validate Tool input", description: "Actual schema and capability checks; no execution authority is granted.",
  steps: [{id: "validate", label: "Validate selected input", kind: "check", checks: ["schema", "semantic", "issue_hint"]}],
  transitions: [], entryStepIds: ["validate"], exitStepIds: ["validate"]});

export function admitObservedToolCall(input: ToolCallAdmissionInput, context: ExecutionFlowContext, runId: string) {
  const call = input.modelCall ? [{owner: "runtime", kind: "call", id: input.modelCall.id, revision: null}] : [];
  const flow = new ExecutionFlowInvocation(definition, context, runId, call);
  const step = flow.enter("validate", {inputs: call});
  try {
    const result = admitToolCall({...input, observeValidation(check) {
      const material = flow.material("Tool input validation", check.stage, {
        toolFingerprint: check.toolFingerprint, stage: check.stage, status: check.status, issues: check.issues, scope: check.scope,
      });
      step.output(material);
      step.check(check.stage, check.status === "valid" ? "passed" : check.status === "invalid" ? "not_satisfied" : "error",
        {toolFingerprint: check.toolFingerprint, issueCount: check.issues.length},
        check.configuration ? {...check.configuration.ref, runId: null} : null);
    }});
    step.output(flow.material("Tool admission result", "admitted", {
      status: result.status, code: result.status === "rejected" ? result.code : null,
      operationDispatch: result.status === "rejected" ? "not_dispatched" : "not_yet_dispatched",
      validation: result.status === "rejected" ? result.validation : null,
    }));
    step.end("returned", {status: result.status});
    flow.close("returned", step.ref);
    return result;
  } catch (error) {
    step.end("failed"); flow.close("failed", step.ref); throw error;
  }
}
