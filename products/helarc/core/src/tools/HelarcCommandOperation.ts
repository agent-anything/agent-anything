import type { OperationBindingResolutionInput, OperationBindingResolverRegistration } from "@agent-anything/operation-catalog/binding";
import { snapshotResolvedOperationBinding } from "@agent-anything/operation-catalog/binding";
import type { RegisteredOperation } from "@agent-anything/operation-catalog/catalog";
import type { OperationBindingRevisionRef, OperationRevisionRef } from "@agent-anything/operation-catalog/identity";
import type { ToolRegistrationInput } from "@agent-anything/tools/registration";
import { findHelarcBaselineToolContract, type HelarcShellToolName } from "./HelarcBaselineToolContracts.js";
import {createHelarcShellComposite} from "./HelarcShellComposite.js";
import type {CompositeOperationResolverPort} from "@agent-anything/agent-runtime/runner";

export const HELARC_TASK_STOP_TOOL = "TaskStop";

export interface HelarcCommandOperationContribution {
  readonly operations: readonly RegisteredOperation[];
  readonly bindings: readonly OperationBindingResolverRegistration[];
  readonly tools: readonly ToolRegistrationInput[];
  readonly composite: CompositeOperationResolverPort;
}

import {HELARC_SHELL_OPERATION, HELARC_SHELL_BINDING, HELARC_PROCESS_START_OPERATION, HELARC_PROCESS_START_BINDING, HELARC_INITIAL_OBSERVATION_OPERATION, HELARC_INITIAL_OBSERVATION_BINDING, HELARC_TASK_OUTPUT_OPERATION, HELARC_TASK_OUTPUT_BINDING, HELARC_INITIAL_OBSERVATION_HANDLER, HELARC_TASK_OUTPUT_HANDLER, HELARC_SHELL_COMPOSITE, HELARC_TASK_STOP_OPERATION, HELARC_TASK_STOP_BINDING} from "./HelarcCommandIdentity.js";
export {HELARC_SHELL_OPERATION, HELARC_SHELL_BINDING, HELARC_PROCESS_START_OPERATION, HELARC_PROCESS_START_BINDING, HELARC_INITIAL_OBSERVATION_OPERATION, HELARC_INITIAL_OBSERVATION_BINDING, HELARC_TASK_OUTPUT_OPERATION, HELARC_TASK_OUTPUT_BINDING, HELARC_INITIAL_OBSERVATION_HANDLER, HELARC_TASK_OUTPUT_HANDLER, HELARC_SHELL_COMPOSITE, HELARC_TASK_STOP_OPERATION, HELARC_TASK_STOP_BINDING} from "./HelarcCommandIdentity.js";

export function createHelarcCommandOperationContribution(input: {
  readonly shellTool: HelarcShellToolName;
  readonly shellActionAdapterId: string;
  readonly taskStopActionAdapterId: string;
  readonly admittedAt: string;
}): HelarcCommandOperationContribution {
  return Object.freeze({
    operations: Object.freeze([
      operation("helarc.shell.admission.v3", input.admittedAt, HELARC_SHELL_OPERATION, HELARC_SHELL_BINDING, "helarc.shell.composite", "code-agent.shell", "composite"),
      operation("helarc.process-start.admission.v1", input.admittedAt, HELARC_PROCESS_START_OPERATION, HELARC_PROCESS_START_BINDING, "helarc.process.start", "command.start", "direct", false),
      operation("helarc.initial-observation.admission.v1", input.admittedAt, HELARC_INITIAL_OBSERVATION_OPERATION, HELARC_INITIAL_OBSERVATION_BINDING, "helarc.process.initial", "command.observe", "internal", false),
      operation("helarc.task-output.admission.v1", input.admittedAt, HELARC_TASK_OUTPUT_OPERATION, HELARC_TASK_OUTPUT_BINDING, "helarc.process.output", "command.observe", "internal"),
      operation("helarc.task-stop.admission.v2", input.admittedAt, HELARC_TASK_STOP_OPERATION, HELARC_TASK_STOP_BINDING, "helarc.task-stop.direct", "code-agent.task-stop"),
    ]),
    bindings: Object.freeze([
      binding("helarc.shell.composite", HELARC_SHELL_BINDING, HELARC_SHELL_COMPOSITE,"composite"),
      binding("helarc.process.start", HELARC_PROCESS_START_BINDING, input.shellActionAdapterId),
      binding("helarc.process.initial", HELARC_INITIAL_OBSERVATION_BINDING, HELARC_INITIAL_OBSERVATION_HANDLER,"internal"),
      binding("helarc.process.output", HELARC_TASK_OUTPUT_BINDING, HELARC_TASK_OUTPUT_HANDLER,"internal"),
      binding("helarc.task-stop.direct", HELARC_TASK_STOP_BINDING, input.taskStopActionAdapterId),
    ]),
    tools: Object.freeze([
      tool("helarc.tool.shell.admission.v2", findHelarcBaselineToolContract(input.shellTool), HELARC_SHELL_BINDING, input.admittedAt),
      tool("helarc.tool.task-stop.admission.v2", findHelarcBaselineToolContract("TaskStop"), HELARC_TASK_STOP_BINDING, input.admittedAt),
      tool("helarc.tool.task-output.admission.v1", findHelarcBaselineToolContract("TaskOutput"), HELARC_TASK_OUTPUT_BINDING, input.admittedAt),
    ]),
    composite:createHelarcShellComposite(),
  });
}

function operation(admissionId: string, admittedAt: string, ref: OperationRevisionRef, bindingRef: OperationBindingRevisionRef, resolverId: string, domainPurpose: string,kind:"direct"|"internal"|"composite"="direct",exposed=true): RegisteredOperation {
  return {
    admissionId,
    operation: {
      ref, semanticOwner: "helarc", requestSchemaRevision: "1", resultSchemaRevision: ref.revision,
      roles: { requestOrigins: [exposed ? "tool_request":"trusted_workflow"], exposure: exposed ? "eager_tool":"workflow_only", runControl: kind, trust: kind === "internal" ? "effect_free":"canonical_external_effect", participation: "semantic_owner", domainPurpose },
    },
    binding: { ref: bindingRef, kind, resolverId, resolverRevision: bindingRef.revision },
    sourceRevision: ref.revision, allowedRequestOrigins: [exposed ? "tool_request":"trusted_workflow"], admittedAt, retirement: null,
  };
}

function binding(resolverId: string, bindingRef: OperationBindingRevisionRef, target: string,kind:"direct"|"internal"|"composite"="direct"): OperationBindingResolverRegistration {
  return {
    resolver: Object.freeze({
      id: resolverId, revision: bindingRef.revision,
      async resolve(request: OperationBindingResolutionInput<unknown, unknown>) {
        return Object.freeze({
          status: "resolved" as const,
          binding: snapshotResolvedOperationBinding({
            ...(kind === "direct" ? {kind,actionAdapterId:target} : kind === "internal" ? {kind,handlerId:target} : {kind,compositeDefinitionRef:target}), invocation: request.context.invocation, correlation: request.context.correlation,
            parentInvocation: request.context.parentInvocation, binding: bindingRef, request: request.request,
            resolverRevision: bindingRef.revision, resolutionFingerprint: `${request.context.invocation.id}:${kind}:${target}`,
          }, snapshotRequest),
        });
      },
    }),
  };
}

function tool(admissionId: string, contract: ReturnType<typeof findHelarcBaselineToolContract>, operationBinding: OperationBindingRevisionRef, admittedAt: string): ToolRegistrationInput {
  const revision = operationBinding.operation.revision;
  return {
    admissionId,
    descriptor: {
      ref: { tool: { namespace: "helarc", name: contract.name.toLowerCase() }, revision },
      name: contract.name, description: contract.description, inputSchema: contract.inputSchema,
      schemaRevisions: { dialect: "json-schema-2020-12", input: "1", output: revision, translation: `native-${revision}` },
      annotations: contract.annotations,
      source: { kind: "product", sourceId: "helarc", sourceRevision: revision, activationEpoch: null },
      binding: { kind: "operation", ...operationBinding }, retirement: null, metadata: { profile: "code-agent" },
    },
    allowedOrigins: ["model"], admittedAt,
  };
}

function snapshotRequest<T>(input: T): T { return deepFreeze(structuredClone(input)); }
function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}
