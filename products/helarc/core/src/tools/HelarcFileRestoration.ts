import { CODE_FILE_RESTORE_OPERATION, CODE_FILE_RESTORE_BINDING, isFileFailureSupport } from "@agent-anything/helarc-code-agent/file-operation";
import { snapshotResolvedOperationBinding, type OperationBindingResolverRegistration } from "@agent-anything/operation-catalog/binding";
import type { RegisteredOperation } from "@agent-anything/operation-catalog/catalog";
import type { OperationResultContract } from "@agent-anything/operation-catalog/result";
import type { ToolRegistrationInput } from "@agent-anything/tools/registration";
import type { ToolJsonObject } from "@agent-anything/tools/catalog";
import { EXECUTION_REFERENCE_SCHEMA } from "./HelarcExecutionDetails.js";
import { HELARC_COMPENSATION_INPUT_REVISION } from "./HelarcCompensationInput.js";

export const FILE_RESTORE_ADAPTER_ID = "helarc.local.filesystem.restore.adapter";
export const FILE_RESTORE_DESCRIPTION = "Request restoration of one exact file change using change_ref from a Tool result. Restores captured prior bytes or removes that same newly created file. Requires retained material, current read/mutation permission and unchanged target identity/content/root/ancestry. No force, merge, arbitrary backup path, directory deletion, whole-Run rewind or metadata restoration. A conflict makes no requested mutation: inspect current state and material before choosing ordinary editing. External writers are not excluded. This is a new governed operation; success is scoped to the recorded file postcondition, not the overall task.";
export const FILE_RESTORE_SCHEMA: ToolJsonObject = {type: "object", additionalProperties: false, required: ["change_ref"],
  properties: {change_ref: {...EXECUTION_REFERENCE_SCHEMA, description: "Exact effect reference of the file change to address, copied from its result.",
    properties: {...EXECUTION_REFERENCE_SCHEMA.properties as ToolJsonObject, kind: {const: "effect"}}}}};

export function createHelarcFileRestorationContribution(admittedAt: string) {
  const resolverId = "helarc.file-restoration";
  const operation: RegisteredOperation = {admissionId: `${resolverId}.admission`, admittedAt, retirement: null, sourceRevision: "1",
    allowedRequestOrigins: ["tool_request"], operation: {ref: CODE_FILE_RESTORE_OPERATION, semanticOwner: "helarc.code-agent",
      requestSchemaRevision: "1", resultSchemaRevision: "1", roles: {requestOrigins: ["tool_request"], exposure: "eager_tool", runControl: "direct",
        trust: "canonical_external_effect", participation: "semantic_owner", domainPurpose: "file.restore"}},
    binding: {ref: CODE_FILE_RESTORE_BINDING, kind: "direct", resolverId, resolverRevision: "1"}};
  const resolver: OperationBindingResolverRegistration = {resolver: {id: resolverId, revision: "1", async resolve(input) {
    return {status: "resolved", binding: snapshotResolvedOperationBinding({kind: "direct", actionAdapterId: FILE_RESTORE_ADAPTER_ID,
      invocation: input.context.invocation, correlation: input.context.correlation, parentInvocation: input.context.parentInvocation,
      binding: CODE_FILE_RESTORE_BINDING, request: input.request, resolverRevision: "1", resolutionFingerprint: `${input.context.invocation.id}:restore`}, value => structuredClone(value))};
  }}};
  const tool: ToolRegistrationInput = {admissionId: `${resolverId}.tool`, admittedAt, allowedOrigins: ["model"], descriptor: {
    ref: {tool: {namespace: "helarc.code-agent", name: "restore"}, revision: "1"}, name: "RestoreFile", description: FILE_RESTORE_DESCRIPTION,
    inputSchema: FILE_RESTORE_SCHEMA, schemaRevisions: {dialect: "json-schema-2020-12", input: "1", output: "1", translation: "native-1"},
    annotations: {title: "Restore file", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false},
    source: {kind: "product", sourceId: "helarc", sourceRevision: "1", activationEpoch: null},
    binding: {kind: "operation", ...CODE_FILE_RESTORE_BINDING}, retirement: null,
    metadata: {profile: "workspace-write", compensationInputRevision: HELARC_COMPENSATION_INPUT_REVISION, compensationTargetInput: "change_ref"},
  }};
  const contract: OperationResultContract = {operation: CODE_FILE_RESTORE_OPERATION, revision: "1", validateOutput(result) {
    if (result.status !== "succeeded") return result.output === null || isFileFailureSupport(result.output);
    const value = result.output as Record<string, unknown> | null;
    return value !== null && typeof value === "object" && (value.operation === "restored" || value.operation === "removed") &&
      typeof value.file_path === "string" && typeof value.byte_length === "number" && typeof value.content_digest === "string";
  }};
  return {operation, resolver, tool, contract};
}
