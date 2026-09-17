import { createExecutionFlowDefinition, type ExecutionFlowInvocation, type ExecutionFlowSubjectRef } from "@agent-anything/observability/execution-flow";
import type { Agent } from "@agent-anything/agent-core/agent";
import type { ControllerInput } from "../controller/Controller.js";
import type { PrepareControllerOperationInput } from "./ControllerOperation.js";

export const CONTROLLER_EXECUTION_FLOW = createExecutionFlowDefinition({
  owner: "agent-runtime", id: "controller-execution", revision: "2", label: "Controller and Context",
  description: "Capture Tool Exposure, project Context, call the Controller, and validate the returned decision against its actual basis.",
  steps: [
    {id: "exposure", label: "Resolve Tool Exposure", kind: "entry", checks: ["basis_revision"]},
    {id: "context", label: "Prepare Controller input", kind: "process", checks: ["projection_contract"]},
    {id: "controller", label: "Invoke Controller", kind: "call", checks: []},
    {id: "validity", label: "Recheck decision basis", kind: "check", checks: ["freshness"]},
    {id: "decision", label: "Validate and record decision", kind: "exit", checks: ["decision_contract"]},
  ],
  transitions: [["exposure","context"],["context","controller"],["controller","validity"],["validity","decision"]].map(([from,to]) => ({id:`${from}:${to}`,from:from!,to:to!,label:`${from} to ${to}`})),
  entryStepIds: ["exposure"], exitStepIds: ["decision"],
});

export function recordControllerPreparation<TOutput>(
  flow: ExecutionFlowInvocation,
  input: Pick<PrepareControllerOperationInput<TOutput>, "agent" | "instructionBinding" | "config" | "state" | "modelInteractionSeed" | "descendants">,
): readonly ExecutionFlowSubjectRef[] {
  const { state, config } = input;
  const { permissions } = config;
  const { reviewer, sessionAuthority } = permissions;
  return [
    {owner: "runtime", kind: "contribution", id: `${state.run.id}:input`, revision: "1"},
    flow.material("Decision preparation state", "before_preparation", {
      run: state.run, revision: state.revision, status: state.status,
      context: state.context.ref, plan: state.plan, permission: state.permission,
      pending: state.pending, descendants: input.descendants,
      counters: state.counters, metadata: state.metadata,
      history: {
        seedMessages: input.modelInteractionSeed,
        items: state.items.map(item => ({ref: item.ref, kind: item.payload.kind})),
      },
    }),
    flow.material("Decision preparation settings", "before_preparation", {
      agent: agentData(input.agent), instructionBinding: input.instructionBinding,
      workspace: config.workspace, identity: config.identity,
      permissions: {
        permissionProfile: permissions.permissionProfile,
        approvalPolicy: permissions.approvalPolicy,
        reviewer: reviewer === null ? null : {
          kind: reviewer.kind, bindingId: reviewer.bindingId, descriptor: reviewer.descriptor,
          ...(reviewer.kind === "auto_review" ? {reviewTimeoutMs: reviewer.reviewTimeoutMs} : {}),
        },
        rules: permissions.rules, networkRules: permissions.networkRules,
        managedConstraints: permissions.managedConstraints,
        sessionAuthority: sessionAuthority === null ? null : {
          context: sessionAuthority.context, initialRecords: sessionAuthority.initialRecords,
        },
        authorityApplicationLimits: permissions.authorityApplicationLimits,
      },
      planLimits: config.limits.plan,
      toolSelection: {revision: config.tools.revision, tools: config.tools.tools.map(tool => tool.registration.descriptor.ref)},
      excludedExecutableFields: [
        "agent.output.validate", "permissions.reviewer.reviewer",
        "permissions.sessionAuthority.port", "permissions.persistentPolicyAmendments",
      ],
    }),
  ];
}

export function recordControllerInput<TOutput>(flow: ExecutionFlowInvocation, input: ControllerInput<TOutput>): ExecutionFlowSubjectRef {
  return flow.material("Controller input", "prepared", {
    input: {...input, agent: agentData(input.agent)},
    excludedExecutableFields: ["input.agent.output.validate"],
  });
}

function agentData<TOutput>(agent: Agent<TOutput>) {
  return {id: agent.id, revision: agent.revision, name: agent.name, instructions: agent.instructions, metadata: agent.metadata};
}
