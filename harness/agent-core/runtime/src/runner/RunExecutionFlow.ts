import { createExecutionFlowDefinition, ExecutionFlowInvocation, type ExecutionFlowBasis, type ExecutionFlowContext, type ExecutionFlowStep, type ExecutionFlowSubjectRef } from "@agent-anything/observability/execution-flow";

const steps = [
  {id: "initialize", label: "Initialize Run", kind: "entry", checks: ["initial_context", "required_start_records"]},
  {id: "controls", label: "Apply controls and execution limits", kind: "check", checks: ["cancellation", "deadline", "numeric_limits", "resource_account"]},
  {id: "controller", label: "Request typed decision", kind: "call", checks: []},
  {id: "decision", label: "Dispatch typed decision", kind: "branch", checks: ["current_basis", "cancellation"]},
  {id: "admission", label: "Admit Model Calls", kind: "check", checks: ["tool_admission"]},
  {id: "dispatch", label: "Schedule and execute Calls", kind: "call", checks: ["cancellation", "steering", "action_capacity"]},
  {id: "join", label: "Join Model Call results", kind: "wait", checks: ["unsettled_calls"]},
  {id: "completion", label: "Check normal completion candidate", kind: "check", checks: ["cancellation", "active_state", "descendant_obligations"]},
  {id: "finalizers", label: "Settle resources and required records", kind: "call", checks: ["required_finalizers", "resource_account", "cancellation"]},
  {id: "terminal", label: "Commit one terminal result", kind: "exit", checks: ["terminal_barrier"]},
] as const;
type StepId = typeof steps[number]["id"];
const routes: readonly (readonly [StepId, StepId])[] = [
  ["initialize","controls"], ["controls","controller"], ["controller","decision"], ["controller","controls"],
  ["decision","controls"], ["decision","admission"], ["decision","completion"], ["admission","dispatch"],
  ["dispatch","dispatch"], ["dispatch","join"], ["join","controls"], ["completion","controls"],
  ...steps.filter(step => !["terminal","finalizers"].includes(step.id)).map(step => [step.id, "finalizers"] as const),
  ["finalizers","terminal"],
];
export const RUN_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner: "agent-runtime", id: "run-execution", revision: "2", label: "Harness Core Loop",
  description: "Runner-owned progression and mechanical settlement. Normal completion does not assert task success.",
  steps, transitions: routes.map(([from,to]) => ({id: `${from}:${to}`, from, to, label: `${from} to ${to}`})),
  entryStepIds: ["initialize"], exitStepIds: ["terminal"],
});

/** This cursor follows only the Runner's serial control path, never concurrent work. */
export class RunExecutionFlow {
  readonly invocation: ExecutionFlowInvocation<StepId>;
  current: ExecutionFlowStep | null = null;
  private currentId: StepId | null = null;
  constructor(context: ExecutionFlowContext, runId: string) {
    this.invocation = new ExecutionFlowInvocation<StepId>(RUN_EXECUTION_FLOW, context, runId, [{owner: "runtime", kind: "run", id: runId, revision: null}]);
  }
  enter(id: StepId, basis: ExecutionFlowBasis = {}, inputs: readonly ExecutionFlowSubjectRef[] = []): ExecutionFlowStep {
    const previous = this.current;
    const previousId = this.currentId;
    previous?.end("returned", {}, id);
    const step = this.invocation.enter(id, {basis, inputs});
    if (previous && previousId) this.invocation.link(previous.ref, step.ref, "next", `${previousId}:${id}`);
    this.current = step;
    this.currentId = id;
    return step;
  }
  get context(): ExecutionFlowContext { return this.current?.context ?? this.invocation.context; }
  close(status: "completed" | "failed" | "cancelled"): void {
    const disposition = status === "completed" ? "returned" : status;
    this.current?.end(disposition, {status});
    this.invocation.close(disposition, this.current?.ref ?? null);
  }
}
