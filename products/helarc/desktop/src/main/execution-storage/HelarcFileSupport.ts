import { allowsRetainedFileRead } from "@agent-anything/permission";
import { ExecutionMaterialAccessError, type HelarcExecutionMaterialReader } from "@agent-anything/helarc/tools";
import type { FileSupportServices } from "@agent-anything/helarc-local-environment/filesystem";
import type { RetainedRunTreeMember } from "@agent-anything/agent-runtime/runner";
import type { HelarcExecutionStore } from "./HelarcExecutionStore.js";

/** Current Run authority controls retained reads independently of reference visibility. */
export function createHelarcFileSupport(store: HelarcExecutionStore, rootRunId: string) {
  const admissions = new Map<string, RetainedRunTreeMember["admission"]>();
  const authorizeRead: FileSupportServices["authorizeRead"] = async ({runId, path}) => {
    let admission = admissions.get(runId);
    if (!admission) {
      admission = (await store.readRunCommit(`${runId}:commit:0`))?.admission ?? undefined;
      if (!admission || admission.lineage.root.id !== rootRunId) return null;
      admissions.set(runId, admission);
    }
    const latest = await store.readLatestRun(runId);
    if (!latest || !["initializing", "running", "waiting", "cancelling"].includes(latest.state.status)) return null;
    const state = latest.state.permission;
    const permitted = allowsRetainedFileRead({profile: admission.config.permissions.permissionProfile, path,
      grants: [...state.runPermissionGrants.map(grant => grant.permissions),
        ...state.sessionAuthorityRecords.flatMap(record => record.grantedPermissions === null ? [] : [record.grantedPermissions])]});
    return permitted ? `${latest.id}:retained-read` : null;
  };
  const support: FileSupportServices = {records: store, authorizeRead};
  const materials: HelarcExecutionMaterialReader = {async describe(reference) {
    if (reference.owner !== "helarc-files") return {availability: "unknown", reason: "source_owner_unavailable"};
    const record = await store.readFileMaterialRecord(reference);
    return record ? {availability: record.state, reason: record.reason, expiresAt: record.expiresAt} : {availability: "not_captured", reason: "manifest_unavailable"};
  }, async read(input) {
    if (input.reference.owner !== "helarc-files") unavailable("execution_material_owner_unavailable", "The material source owner has no registered content reader.");
    const record = await store.readFileMaterialRecord(input.reference);
    if (!record || record.state !== "available") unavailable("file_material_content_unavailable", "Retained bytes are unavailable, incomplete or expired.");
    const path = record.preparation.target.canonicalPath;
    if (!await authorizeRead({runId: input.runId, path})) unavailable("file_material_read_not_authorized", "Current read authority is required; historical read permission is not reused.");
    if (record.preparation.before.kind === "absent") return {kind: "absence", reference: input.reference, byte_length: 0, text: null};
    if (input.signal.aborted) unavailable("execution_details_interrupted", "Material lookup was cancelled.");
    if (input.offset > record.preparation.byteLength) unavailable("execution_details_range_invalid", "Byte offset exceeds retained material length.");
    await store.pinFileMaterial(input.reference, input.runId);
    const page = await store.readFileMaterialRange(input.reference, input.offset, input.length);
    if (input.signal.aborted || !await authorizeRead({runId: input.runId, path})) unavailable("file_material_read_not_authorized", "Read authority changed before material delivery.");
    let text: string | null = null;
    try {text = new TextDecoder("utf-8", {fatal: true}).decode(Buffer.from(page.base64, "base64"));} catch { /* The exact bytes remain available, including split UTF-8 ranges. */ }
    return {...page, encoding: text === null ? "base64" : "utf-8", text,
      next_offset: page.offset + page.byteLength < page.totalBytes ? page.offset + page.byteLength : null,
      limitations: text === null ? ["This byte range is not independently valid UTF-8; base64 preserves its exact bytes."] : []};
  }};
  return {support, materials};
}
function unavailable(code: string, message: string): never {throw new ExecutionMaterialAccessError(code, message);}
