import type { OperationBindingResolutionInput, OperationBindingResolverRegistration } from "@agent-anything/operation-catalog/binding";
import { snapshotResolvedOperationBinding } from "@agent-anything/operation-catalog/binding";
import type { RegisteredOperation } from "@agent-anything/operation-catalog/catalog";
import type { OperationBindingRevisionRef, OperationRevisionRef } from "@agent-anything/operation-catalog/identity";
import type { ToolRegistrationInput } from "@agent-anything/tools/registration";
import { findHelarcBaselineToolContract, type HelarcShellToolName } from "./HelarcBaselineToolContracts.js";

export const HELARC_TASK_STOP_TOOL = "TaskStop";

export interface HelarcCommandOperationContribution {
  readonly operations: readonly RegisteredOperation[];
  readonly bindings: readonly OperationBindingResolverRegistration[];
  readonly tools: readonly ToolRegistrationInput[];
}

export const HELARC_SHELL_OPERATION: OperationRevisionRef = Object.freeze({
  operation: Object.freeze({ namespace: "helarc", name: "shell-execute" }), revision: "1",
});
export const HELARC_SHELL_BINDING: OperationBindingRevisionRef = Object.freeze({ operation: HELARC_SHELL_OPERATION, revision: "1" });
export const HELARC_TASK_STOP_OPERATION: OperationRevisionRef = Object.freeze({
  operation: Object.freeze({ namespace: "helarc", name: "task-stop" }), revision: "1",
});
export const HELARC_TASK_STOP_BINDING: OperationBindingRevisionRef = Object.freeze({ operation: HELARC_TASK_STOP_OPERATION, revision: "1" });

export function createHelarcCommandOperationContribution(input: {
  readonly shellTool: HelarcShellToolName;
  readonly shellActionAdapterId: string;
  readonly taskStopActionAdapterId: string;
  readonly admittedAt: string;
}): HelarcCommandOperationContribution {
  return Object.freeze({
    operations: Object.freeze([
      operation("helarc.shell.admission.v1", input.admittedAt, HELARC_SHELL_OPERATION, HELARC_SHELL_BINDING, "helarc.shell.direct", "code-agent.shell"),
      operation("helarc.task-stop.admission.v1", input.admittedAt, HELARC_TASK_STOP_OPERATION, HELARC_TASK_STOP_BINDING, "helarc.task-stop.direct", "code-agent.task-stop"),
    ]),
    bindings: Object.freeze([
      binding("helarc.shell.direct", HELARC_SHELL_BINDING, input.shellActionAdapterId),
      binding("helarc.task-stop.direct", HELARC_TASK_STOP_BINDING, input.taskStopActionAdapterId),
    ]),
    tools: Object.freeze([
      tool("helarc.tool.shell.admission.v1", findHelarcBaselineToolContract(input.shellTool), HELARC_SHELL_BINDING, input.admittedAt),
      tool("helarc.tool.task-stop.admission.v1", findHelarcBaselineToolContract("TaskStop"), HELARC_TASK_STOP_BINDING, input.admittedAt),
    ]),
  });
}

function operation(admissionId: string, admittedAt: string, ref: OperationRevisionRef, bindingRef: OperationBindingRevisionRef, resolverId: string, domainPurpose: string): RegisteredOperation {
  return {
    admissionId,
    operation: {
      ref, semanticOwner: "helarc", requestSchemaRevision: "1", resultSchemaRevision: "1",
      roles: { requestOrigins: ["tool_request"], exposure: "eager_tool", runControl: "direct", trust: "canonical_external_effect", participation: "semantic_owner", domainPurpose },
    },
    binding: { ref: bindingRef, kind: "direct", resolverId, resolverRevision: "1" },
    sourceRevision: "1", allowedRequestOrigins: ["tool_request"], admittedAt, retirement: null,
  };
}

function binding(resolverId: string, bindingRef: OperationBindingRevisionRef, actionAdapterId: string): OperationBindingResolverRegistration {
  return {
    resolver: Object.freeze({
      id: resolverId, revision: "1",
      async resolve(request: OperationBindingResolutionInput<unknown, unknown>) {
        return Object.freeze({
          status: "resolved" as const,
          binding: snapshotResolvedOperationBinding({
            kind: "direct", invocation: request.context.invocation, correlation: request.context.correlation,
            parentInvocation: request.context.parentInvocation, binding: bindingRef, request: request.request,
            resolverRevision: "1", resolutionFingerprint: `${request.context.invocation.id}:direct:${actionAdapterId}`, actionAdapterId,
          }, snapshotRequest),
        });
      },
    }),
  };
}

function tool(admissionId: string, contract: ReturnType<typeof findHelarcBaselineToolContract>, operationBinding: OperationBindingRevisionRef, admittedAt: string): ToolRegistrationInput {
  return {
    admissionId,
    descriptor: {
      ref: { tool: { namespace: "helarc", name: contract.name.toLowerCase() }, revision: "1" },
      name: contract.name, description: contract.description, inputSchema: contract.inputSchema,
      schemaRevisions: { dialect: "json-schema-2020-12", input: "1", output: "1", translation: "native-1" },
      annotations: contract.annotations,
      source: { kind: "product", sourceId: "helarc", sourceRevision: "1", activationEpoch: null },
      operationBinding, retirement: null, metadata: { profile: "code-agent" },
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
