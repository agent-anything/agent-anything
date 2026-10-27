import type {
  ActionPreparationRecord, PreparedActionRecord, ActionDispatchIntent, ActionAttemptResultRecord,
  ActionSettlementRecord, ActionRetryRecord, ActionRecoveryRecords,
} from "@agent-anything/action-execution/enforcement";
import type { RunCommit, RunCommitReceipt, RunTreeCommit, RunTreeCommitReceipt, RunTreeRecoveryRecords } from "@agent-anything/agent-runtime/execution-coordinator";
import type { CompositeCommit } from "@agent-anything/operation-composition/execution";
import type { AgentHookInvocationCheckpoint } from "@agent-anything/agent-hooks/execution";
import type { ShellSessionCommit } from "@agent-anything/helarc-local-environment/command";
import type {StoredProcessCheckpoint as ProcessCheckpoint} from "./ExecutionEnvironmentProtection.js";
import type { HelarcExecutionAdmission, HelarcExecutionDiscovery } from "./HelarcExecutionAdmission.js";
import type { ExecutionEvidenceRecord, ExecutionEvidenceRef, CompensationAssociation } from "@agent-anything/operation-catalog/evidence";
import type {ExecutionReferenceTransfer, ExecutionReferencePage} from "@agent-anything/operation-catalog/evidence";
import type { FileMaterialPreparation, FileMaterialRecord, FileMaterialReservation, FileMaterialRead } from "@agent-anything/helarc-local-environment/filesystem";
import type { ExecutionErrorDetails } from "../diagnostics/ExecutionErrorDetails.js";
import type {ExecutionContentBlock, ExecutionContentRoot} from "./ExecutionContent.js";
import type {ExecutionPerformanceEvent} from "../diagnostics/ExecutionPerformance.js";
import type {ContextMaterialCommand, ContextMaterialValue} from "./ContextMaterialDatabase.js";

export type ExecutionOwnerCommit =
  | {readonly kind: "run"; readonly value: RunCommit}
  | {readonly kind: "composite"; readonly value: CompositeCommit};

export type ActionOwnerRecord =
  | { readonly kind: "prepared_action"; readonly value: PreparedActionRecord }
  | { readonly kind: "preparation"; readonly value: ActionPreparationRecord }
  | { readonly kind: "dispatch_intent"; readonly value: ActionDispatchIntent }
  | { readonly kind: "attempt_result"; readonly value: ActionAttemptResultRecord }
  | { readonly kind: "retry"; readonly value: ActionRetryRecord }
  | { readonly kind: "settlement"; readonly value: ActionSettlementRecord };

export interface ExecutionRecordReceipt {
  readonly recordId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly digest: string;
}

export interface ExecutionRetentionPin {
  readonly ownerId: string;
  readonly reason: "unfinished_run" | "undelivered_result" | "unsettled_process" | "file_material" | "context_material";
}

export type FileMaterialStoreCommand =
  | {readonly kind: "reserve"; readonly preparation: FileMaterialPreparation}
  | {readonly kind: "append"; readonly reference: ExecutionEvidenceRef<"material">; readonly offset: number; readonly base64: string}
  | {readonly kind: "publish"; readonly reference: ExecutionEvidenceRef<"material">; readonly digest: string; readonly at: string}
  | {readonly kind: "read"; readonly reference: ExecutionEvidenceRef<"material">}
  | {readonly kind: "read_range"; readonly reference: ExecutionEvidenceRef<"material">; readonly offset: number; readonly length: number}
  | {readonly kind: "abort"; readonly reference: ExecutionEvidenceRef<"material">; readonly reason: string; readonly at: string}
  | {readonly kind: "pin"; readonly reference: ExecutionEvidenceRef<"material">; readonly ownerId: string}
  | {readonly kind: "release"; readonly reference: ExecutionEvidenceRef<"material">; readonly ownerId: string; readonly at: string}
  | {readonly kind: "expire"; readonly at: string};

export type FileMaterialStoreValue = FileMaterialRecord | readonly FileMaterialRecord[] | FileMaterialReservation | FileMaterialRead | null;

export type ExecutionStoreCommand =
  | {readonly kind: "register_recording"; readonly recording: import("./ExecutionRecording.js").ExecutionRecording}
  | {readonly kind: "context_preparation"; readonly command: import("./ContextPreparationDatabase.js").ContextPreparationCommand}
  | {readonly kind: "context_material"; readonly command: ContextMaterialCommand}
  | {readonly kind: "commit_reference_transfer"; readonly transfer: ExecutionReferenceTransfer}
  | {readonly kind: "read_reference_transfers"; readonly runId: string}
  | {readonly kind: "read_run_execution_refs"; readonly runId: string; readonly after: string | null; readonly limit: number}
  | {readonly kind: "finalize_file_materials"; readonly rootRunId: string; readonly after: string | null; readonly at: string}
  | {readonly kind: "file_material"; readonly command: FileMaterialStoreCommand}
  | {readonly kind: "commit_execution_evidence"; readonly record: ExecutionEvidenceRecord}
  | {readonly kind: "read_execution_evidence"; readonly reference: ExecutionEvidenceRef}
  | {readonly kind: "commit_compensation_association"; readonly association: CompensationAssociation}
  | {readonly kind: "read_compensation_association"; readonly invocationId: string}
  | {readonly kind: "admit_product_run"; readonly admission: HelarcExecutionAdmission}
  | {readonly kind: "read_product_run"; readonly rootRunId: string}
  | {readonly kind: "list_product_runs"}
  | {readonly kind: "list_retention_pins"}
  | {readonly kind: "commit_product_delivery"; readonly rootRunId: string}
  | {readonly kind: "commit_shell_session"; readonly commit: ShellSessionCommit}
  | {readonly kind: "read_shell_session"; readonly runId: string}
  | {readonly kind: "commit_process"; readonly checkpoint: ProcessCheckpoint}
  | {readonly kind: "read_processes"; readonly runId: string}
  | {readonly kind: "commit_hook"; readonly checkpoint: AgentHookInvocationCheckpoint}
  | {readonly kind: "read_hook"; readonly id: string}
  | {readonly kind: "list_unsettled_hooks"}
  | {readonly kind: "commit_run_tree"; readonly commit: RunTreeCommit}
  | {readonly kind: "read_run_tree_commit"; readonly recordId: string}
  | {readonly kind: "read_run_tree_latest"; readonly rootRunId: string}
  | {readonly kind: "read_run_tree"; readonly rootRunId: string}
  | {readonly kind: "commit_owner"; readonly commit: ExecutionOwnerCommit}
  | {readonly kind: "read_owner_commit"; readonly recordId: string}
  | {readonly kind: "read_owner_latest"; readonly owner: "run" | "composite"; readonly ownerId: string}
  | { readonly kind: "record_action"; readonly record: ActionOwnerRecord }
  | { readonly kind: "read_action"; readonly runId: string; readonly actionId: string }
  | { readonly kind: "read_receipt"; readonly recordId: string }
  | { readonly kind: "close" };

export interface ExecutionStoreRequest {
  readonly id: number;
  readonly generation: number;
  readonly command: ExecutionStoreWireCommand;
}

export type ExecutionStoreWireCommand = ExecutionStoreCommand
  | {readonly kind: "stage_content"; readonly blocks: readonly ExecutionContentBlock[]}
  | {readonly kind: "invoke_content"; readonly root: ExecutionContentRoot}
  | {readonly kind: "read_content"; readonly ids: readonly string[]};

export type FileMaterialFinalizationPage = {readonly records: readonly FileMaterialRecord[]; readonly next: string | null};
export type ExecutionStoreValue = import("./ExecutionRecording.js").ExecutionRecordingRegistration | {preparationValue: unknown} | ContextMaterialValue | readonly ExecutionReferenceTransfer[] | ExecutionReferencePage | FileMaterialFinalizationPage | FileMaterialStoreValue | ExecutionEvidenceRecord | CompensationAssociation | ExecutionRecordReceipt | ActionRecoveryRecords | ExecutionOwnerCommit | RunCommitReceipt | RunTreeCommit | RunTreeCommitReceipt | RunTreeRecoveryRecords | AgentHookInvocationCheckpoint | readonly AgentHookInvocationCheckpoint[] | readonly ProcessCheckpoint[] | ShellSessionCommit | HelarcExecutionAdmission | readonly HelarcExecutionDiscovery[] | readonly ExecutionRetentionPin[] | null;
export type ExecutionStoreReply =
  | {readonly kind: "context_material_observation"; readonly observation: import("./ContextMaterialObservation.js").ContextMaterialObservation}
  | {readonly kind: "performance"; readonly event: ExecutionPerformanceEvent}
  | {readonly kind: "content_staged"; readonly id: number}
  | {readonly kind: "content_result"; readonly id: number; readonly root: ExecutionContentRoot}
  | {readonly kind: "content_blocks"; readonly id: number; readonly blocks: readonly ExecutionContentBlock[]}
  | { readonly kind: "ready"; readonly generation: number }
  | { readonly kind: "startup_failed"; readonly code: string; readonly error: ExecutionErrorDetails }
  | { readonly kind: "result"; readonly id: number; readonly value: ExecutionStoreValue }
  | { readonly kind: "rejected"; readonly id: number; readonly code: string; readonly error: ExecutionErrorDetails };

export class ExecutionStoreError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) { super(code, options); this.name = "ExecutionStoreError"; }
}

export const EXECUTION_STORE_LIMITS = Object.freeze({
  recordBytes: 32 * 1024 * 1024,
  pendingBytes: 128 * 1024 * 1024,
  pendingRequests: 128,
  acknowledgementMs: 30_000,
});
