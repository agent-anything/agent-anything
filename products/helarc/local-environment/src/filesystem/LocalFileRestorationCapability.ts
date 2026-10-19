import { createHash } from "node:crypto";
import type { ActionAdapterImplementation, ActionAdapterPreparedData } from "@agent-anything/action-execution/registration";
import { createPreparedAction } from "@agent-anything/action-execution/registration";
import { assertActionExecutorDispatchContext, type ActionExecutor } from "@agent-anything/action-execution/execution";
import { createActionRegistrationSnapshot } from "@agent-anything/canonical-action/registration";
import { createFileBaseline, type FileBaseline, type SerializableValue } from "@agent-anything/canonical-action/subject";
import { CODE_FILE_RESTORE_OPERATION, CODE_FILE_RESTORE_BINDING, CODE_FILE_CONTENT_CHANGE_SCHEMA } from "@agent-anything/helarc-code-agent/file-operation";
import { resolveExecutionEvidence, snapshotExecutionEvidenceRef, executionEvidenceKey, ExecutionEvidenceUnavailableError,
  type ExecutionEvidenceRecordPort, type ExecutionEvidenceAccessPort, type ExecutionEvidenceRef } from "@agent-anything/operation-catalog/evidence";
import { OperationCommitError } from "@agent-anything/operation-catalog/result";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import { prepareFileSystemTarget, inspectPreparedFileSystemTarget, sameFileBaseline, type PreparedFileSystemTarget } from "./FileSystemTarget.js";
import { snapshotFileMaterialPreparation, type FileMaterialPreparation } from "./FileMaterial.js";
import { fileAncestryIdentity, retainFileSupport, retainedFileFailureSupport, type FileSupportServices } from "./FileSupportCapture.js";
import { restoreBoundFileContent } from "./FileContentRestoration.js";
import { FileSystemError } from "./FileSystemError.js";

const ADAPTER = {id: "helarc.local.filesystem.restore.adapter", version: "1", requestSchemaRevision: "1"};
const EXECUTOR = {id: "helarc.local.filesystem.restore.executor", version: "1", invocationContractVersion: "1", physicalPayloadSchemaRevision: "1"};
interface RestorePayload {
  readonly runId: string;
  readonly invocation: import("@agent-anything/operation-catalog/identity").OperationInvocationRef;
  readonly change: ExecutionEvidenceRef<"effect">;
  readonly material: FileMaterialPreparation;
  readonly after: FileBaseline;
  readonly targetId: string;
  readonly previousByteLength: number;
  readonly target: PreparedFileSystemTarget;
  readonly preparedAt: string;
}

export function createLocalFileRestorationCapability(input: {readonly workspace: WorkspaceSelection | null;
  readonly support?: FileSupportServices; readonly evidence?: ExecutionEvidenceRecordPort; readonly access?: ExecutionEvidenceAccessPort;
  readonly now: () => string;
}) {
  const registrations = createActionRegistrationSnapshot([{registrationId: "helarc.local.filesystem.restore.registration", revision: "1",
    operation: CODE_FILE_RESTORE_OPERATION, binding: CODE_FILE_RESTORE_BINDING, adapter: ADAPTER, executor: EXECUTOR,
    effectFamilies: ["filesystem"], sandboxRequirementRevision: "helarc.local.filesystem.sandbox.v1", executionLifetime: "invocation",
    maxInvocationBytes: 128_000, maxPhysicalResultBytes: 128_000}]);
  const adapter: ActionAdapterImplementation = {adapter: {descriptor: ADAPTER, async prepare(binding, context) {
    try {
      if (!input.support || !input.evidence || !input.access || !context.workspace || !input.workspace || binding.correlation.kind !== "run_action") {
        throw new FileSystemError("file_restore_unavailable", "File restoration requires retained evidence, material and a current Run workspace.");
      }
      const request = binding.request;
      if (!record(request) || Object.keys(request).length !== 1 || !Object.hasOwn(request, "change_ref")) throw new TypeError("Use only change_ref for RestoreFile.");
      const change = snapshotExecutionEvidenceRef(request.change_ref as ExecutionEvidenceRef<"effect">, "effect");
      const runId = binding.correlation.run.id;
      const evidence = await resolveExecutionEvidence({records: input.evidence, access: input.access, runId, reference: change});
      const effect = evidence.effects.find(value => executionEvidenceKey(value.ref) === executionEvidenceKey(change));
      if (!effect || effect.schema.owner !== CODE_FILE_CONTENT_CHANGE_SCHEMA.owner || effect.schema.id !== CODE_FILE_CONTENT_CHANGE_SCHEMA.id ||
          effect.schema.revision !== CODE_FILE_CONTENT_CHANGE_SCHEMA.revision || !CODE_FILE_CONTENT_CHANGE_SCHEMA.validate(effect.value) ||
          !record(effect.value) || !record(effect.value.restoration)) throw new FileSystemError("file_restore_unsupported", "This effect has no retained, confirmed file-restoration source.");
      const materialRef = snapshotExecutionEvidenceRef(effect.value.restoration.material as unknown as ExecutionEvidenceRef<"material">, "material");
      const materialEvidence = await resolveExecutionEvidence({records: input.evidence, access: input.access, runId, reference: materialRef});
      if (executionEvidenceKey(materialEvidence.ref) !== executionEvidenceKey(evidence.ref)) throw new FileSystemError("file_restore_source_invalid", "File material must belong to this exact change receipt.");
      const retained = await input.support.records.readFileMaterialRecord(materialRef);
      if (!retained || retained.state !== "available") throw new FileSystemError("file_material_content_unavailable", "Retained file material is unavailable or expired.");
      const material = snapshotFileMaterialPreparation(retained.preparation);
      if (material.invocation.id !== evidence.source.result.invocation.id || material.runId !== (evidence.source.correlation.kind === "run_action" ? evidence.source.correlation.run.id : null)) {
        throw new FileSystemError("file_restore_source_invalid", "Material and change invocation do not match.");
      }
      const after = createFileBaseline(effect.value.restoration.after as never);
      if (after.kind === "present" && (after.entryKind !== "file" || after.contentDigest === null)) throw new FileSystemError("file_restore_unsupported", "A confirmed file or absence post-state is required.");
      const root = context.workspace.roots.find(value => value.resolutionFingerprint === material.target.rootIdentity);
      if (!root?.resolvedPath) throw new FileSystemError("file_restore_scope_changed", "Original workspace root is not available in the current Run.");
      const target = await prepareFileSystemTarget({workspace: input.workspace, workspaceRoots: context.workspace.roots,
        platform: context.environment.platform, rootName: root.rootId, path: effect.value.file_path as string, operation: after.kind === "absent" ? "write" : "edit"});
      if (target.canonicalTarget !== material.target.canonicalPath || !sameFileBaseline(target.baseline, after)) {
        throw new FileSystemError("file_restore_conflict", "Current file identity or content differs from the recorded post-state. Inspect it; no force restore is supported.");
      }
      const payload: RestorePayload = {runId, invocation: binding.invocation, change, material, after, target, targetId: effect.value.target_id as string,
        previousByteLength: record(effect.value.after) ? effect.value.after.byte_length as number : 0, preparedAt: context.now()};
      await validate(payload);
      const removal = material.before.kind === "absent";
      const data: ActionAdapterPreparedData = {effectSet: {kind: "effects", values: [
        {kind: "file_system", operation: "read", targets: [target.pathIdentity]}, {kind: "file_system", operation: "write", targets: [target.pathIdentity]}]},
        requestedAuthority: null, targetAssertions: [{kind: "workspace_root_identity", expected: {rootId: root.rootId, platform: root.platform,
          path: root.canonicalPath, resolvedPath: root.resolvedPath, resolutionFingerprint: root.resolutionFingerprint}},
          {kind: "canonical_path_identity", expected: target.pathIdentity}, {kind: "file_baseline", path: target.pathIdentity, expected: after}],
        approval: {category: "fileChange", environmentId: context.environment.environmentId,
          applicabilityKeys: [{category: "fileChange", value: `${root.rootId}:${removal ? "delete" : "update"}:${target.relativePath}`}],
          reason: `${removal ? "Remove created file" : "Restore prior content of"} ${target.relativePath}.`,
          payload: {changes: [{operation: removal ? "delete" : "update", canonicalPath: target.canonicalTarget, displayPath: target.relativePath,
            destinationCanonicalPath: null, destinationDisplayPath: null, baselineFingerprint: after.kind === "present" ? after.contentDigest : null}],
            baselineFingerprint: `sha256:${createHash("sha256").update(JSON.stringify(after)).digest("hex")}`,
            additionalPermissions: null}, decisionOptions: [{id: "accept-action", kind: "accept", scope: "action", label: "Allow", description: null, trustedProposalRef: null, metadata: {}},
            {id: "decline", kind: "decline", scope: null, label: "Deny", description: null, trustedProposalRef: null, metadata: {}}], trustedProposals: [],
          deadlineAt: new Date(Date.parse(context.now()) + 120_000).toISOString(), metadata: {}},
        safeSummary: {kind: "file_system", headline: removal ? "Remove created file" : "Restore file content",
          operations: [{operation: removal ? "delete" : "update", sourceLabel: target.relativePath, destinationLabel: null}]},
        preparedInvocation: {contractVersion: "1", executorId: EXECUTOR.id, executorVersion: "1", payload: payload as unknown as SerializableValue},
        replayBasis: "none", semanticBasis: {change}};
      return {status: "prepared", prepared: await createPreparedAction(binding, context, data)};
    } catch (error) {
      if (error instanceof OperationCommitError) throw error;
      if (!(error instanceof TypeError || error instanceof FileSystemError || error instanceof ExecutionEvidenceUnavailableError)) {
        throw new OperationCommitError("helarc-files", binding.invocation.id, {cause: error});
      }
      return {status: "invalid", owner: "helarc-files", code: "code" in error ? String(error.code) : "file_restore_input_invalid", message: error.message};
    }
  }, async revalidate(prepared) {
    try {await validate(readPayload(prepared.invocation.payload)); return {status: "valid", recordId: `${prepared.subject.ref.action.id}:file-restore-check`};}
    catch (error) {
      if (error instanceof OperationCommitError) throw error;
      return {status: "invalidated", owner: "helarc-files", code: "file_restore_conflict", recordId: `${prepared.subject.ref.action.id}:file-restore-conflict`};
    }
  }, async settle(_prepared, settlement) {
    const physical = settlement.payload as {value?: unknown} | null;
    return {operationInvocationId: settlement.operationInvocation.id, settlement,
      status: settlement.status === "invalidated" ? "invalid" : settlement.status,
      output: settlement.status === "succeeded" ? physical?.value ?? null : await retainedFileFailureSupport(input.support, settlement.attempts, settlement.operationInvocation),
      failure: settlement.status === "succeeded" ? null : {owner: settlement.causeOwner ?? "helarc-files", code: settlement.causeRef ?? "file_restore_failed",
        message: settlement.failureDetail?.description ?? settlement.causeRef ?? "File restoration did not complete.",
        ...(settlement.failureDetail === undefined ? {} : {detail: settlement.failureDetail})}};
  }}};
  const executor: ActionExecutor = {descriptor: EXECUTOR, validatePayload(value): value is unknown {return record(value) && record(value.value);}, async execute(invocation, context) {
    assertActionExecutorDispatchContext(context);
    const payload = readPayload(invocation.payload), startedAt = input.now();
    let effectStarted = false;
    try {
      if (!input.support) throw new FileSystemError("file_restore_unavailable", "File material owner is unavailable.");
      await validate(payload);
      let retained: import("@agent-anything/operation-catalog/evidence").ExecutionSupportMaterial | null = null;
      const result = await restoreBoundFileContent({material: payload.material, after: payload.after, runId: payload.runId,
        records: input.support.records, signal: context.interruption.signal, revalidateTarget: () => validate(payload),
        markEffectStarted: () => {effectStarted = true;}, retainPreimage: async handle => {
          retained = await retainFileSupport({services: input.support, origin: {runId: payload.runId, invocation: payload.invocation, preparedAt: payload.preparedAt,
            rootIdentity: payload.material.target.rootIdentity, ancestryIdentity: payload.material.target.ancestryIdentity}, root: payload.target.canonicalRoot,
            path: payload.target.canonicalTarget, before: payload.after, byteLength: handle ? (await handle.stat()).size : 0, attempt: context.attempt,
            handle, signal: context.interruption.signal, now: input.now});
        }});
      const after = result.kind === "absence" ? createFileBaseline({kind: "absent"}) : result.after;
      const baseline = (byteLength: number, digest: string) => ({target_id: payload.targetId, file_path: payload.target.relativePath, byte_length: byteLength, content_digest: digest});
      const value = {operation: result.kind === "absence" ? "removed" : "restored", file_path: payload.target.relativePath, target_id: payload.targetId,
        previous_baseline: payload.after.kind === "absent" ? null : baseline(payload.previousByteLength, payload.after.contentDigest!),
        current_baseline: result.kind === "absence" ? null : baseline(result.byteLength, result.digest),
        file_support: {material: retained, after},
        change_ref: payload.change, byte_length: result.kind === "absence" ? 0 : result.byteLength,
        content_digest: result.kind === "absence" ? `sha256:${createHash("sha256").update("").digest("hex")}` : result.digest,
        postcondition: result.kind === "absence" ? "path_absent" : "captured_content_present",
        limitations: ["Only file content/existence; no metadata or parent-directory restoration.", "External concurrent writers are not excluded."]};
      return {status: "completed", effectState: "settled", payload: {value, startedAt, finishedAt: input.now()}};
    } catch (error) {
      if (error instanceof OperationCommitError) throw error;
      return {status: "failed", effectState: effectStarted ? "unknown" : "none", failure: {code: error instanceof FileSystemError ? error.code : "file_restore_failed",
        message: error instanceof Error ? error.message : "File restoration failed.", metadata: {}, retryable: false}};
    }
  }};
  return {registrations, adapters: [adapter], executors: [executor]};

  async function validate(payload: RestorePayload) {
    if (!input.support) throw new FileSystemError("file_restore_unavailable", "File material owner is unavailable.");
    let authority;
    try {authority = await input.support.authorizeRead({runId: payload.runId, path: payload.target.canonicalTarget});}
    catch (cause) {throw new OperationCommitError("helarc-files", payload.invocation.id, {cause});}
    if (!authority) throw new FileSystemError("file_material_read_not_authorized", "Current read authority is required for retained file content.");
    if (await fileAncestryIdentity(payload.target.canonicalRoot, payload.target.canonicalTarget) !== payload.material.target.ancestryIdentity) {
      throw new FileSystemError("file_restore_conflict", "File ancestry no longer matches the original change.");
    }
    const actual = await inspectPreparedFileSystemTarget({platform: payload.target.workspaceRootIdentity.platform, operation: payload.after.kind === "absent" ? "write" : "edit",
      expectedBaseline: payload.after, workspaceRootIdentity: payload.target.workspaceRootIdentity, workspaceRoot: payload.target.workspaceRoot,
      canonicalRoot: payload.target.canonicalRoot, canonicalTarget: payload.target.canonicalTarget, path: payload.target.pathIdentity.path});
    if (!sameFileBaseline(actual.baseline, payload.after)) throw new FileSystemError("file_restore_conflict", "File content or identity has changed.");
  }
}

function readPayload(value: unknown): RestorePayload {
  if (!record(value) || typeof value.runId !== "string" || !record(value.target) || !record(value.invocation)) throw new TypeError("Invalid prepared restoration.");
  const material = snapshotFileMaterialPreparation(value.material as FileMaterialPreparation);
  const after = createFileBaseline(value.after as FileBaseline);
  return {...value as unknown as RestorePayload, material, after};
}
function record(value: unknown): value is Record<string, unknown> {return value !== null && typeof value === "object" && !Array.isArray(value);}
