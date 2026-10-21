import { Worker } from "node:worker_threads";
import { restoreExecutionError } from "../diagnostics/ExecutionErrorDetails.js";
import { reportExecutionFailure, type ExecutionDiagnosticSink, type ExecutionDiagnosticContext } from "../diagnostics/HelarcExecutionDiagnostics.js";
import {beginExecutionTiming, measureExecutionSync, type ExecutionPerformanceEvent} from "../diagnostics/ExecutionPerformance.js";
import { FILE_MATERIAL_POLICY, snapshotFileMaterialPreparation, type FileMaterialRecordPort, type FileMaterialPreparation, type FileMaterialReservation,
  type FileMaterialRecord, type FileMaterialRead, type FileMaterialObserver, type FileMaterialObservation } from "@agent-anything/helarc-local-environment/filesystem";
import { snapshotExecutionEvidence, snapshotCompensationAssociation, type ExecutionEvidenceRecordPort, type ExecutionEvidenceRecord,
  type ExecutionEvidenceRef, type CompensationAssociation, type ExecutionEvidenceObserver, type ExecutionEvidenceObservation } from "@agent-anything/operation-catalog/evidence";
import {snapshotExecutionReferenceTransfer, type ExecutionReferenceTransfer, type ExecutionReferencePage} from "@agent-anything/operation-catalog/evidence";
import type { HelarcExecutionAdmission, HelarcExecutionDiscovery } from "./HelarcExecutionAdmission.js";
import {ExecutionEnvironmentProtection, type ExecutionEnvironmentCipher, type RetainedCommandEnvironment, type StoredProcessCheckpoint} from "./ExecutionEnvironmentProtection.js";
import type {CommandEnvironmentRecoverySnapshot} from "@agent-anything/helarc-local-environment/command";
import type { ProcessCheckpoint, ProcessRecordPort, ShellSessionRecordPort, ShellSessionCommit } from "@agent-anything/helarc-local-environment/command";
import {unpackExecutionContent, executionContentReferences, ExecutionContentCache, ExecutionContentEncoder, ExecutionContentStatistics, EXECUTION_CONTENT_LIMITS,
  type ExecutionContentBlock, type ExecutionContentRoot} from "./ExecutionContent.js";
import type { RunCommit, RunCommitPort, RunCommitReceipt, RunTreeCommit, RunTreeCommitPort, RunTreeCommitReceipt, RunTreeRecoveryRecords } from "@agent-anything/agent-runtime/runner";
import type { CompositeCommit, CompositeCommitPort } from "@agent-anything/operation-composition/execution";
import type { AgentHookRecordPort, AgentHookInvocationCheckpoint } from "@agent-anything/agent-hooks/execution";
import type {
  ActionRecordPort, ActionRecoveryRecordPort, ActionRecoveryRecords,
} from "@agent-anything/action-execution/enforcement";
import {
  EXECUTION_STORE_LIMITS, ExecutionStoreError, type ActionOwnerRecord,
  type ExecutionStoreCommand, type ExecutionStoreWireCommand, type ExecutionStoreReply, type ExecutionStoreValue,
  type ExecutionRecordReceipt,
  type ExecutionOwnerCommit,
} from "./ExecutionStoreProtocol.js";

interface PendingRequest {
  readonly id: number;
  readonly bytes: number;
  readonly command: ExecutionStoreCommand | null;
  readonly sourceKind: ExecutionStoreCommand["kind"];
  readonly context: ExecutionDiagnosticContext;
  readonly content: ExecutionContentRoot | null;
  readonly upload: readonly ExecutionContentBlock[];
  uploadOffset: number;
  uploaded: readonly string[];
  responseRoot: ExecutionContentRoot | null;
  readonly responseBlocks: Map<string, ExecutionContentBlock>;
  readonly responsePending: Set<string>;
  requestedBlocks: readonly string[];
  responseBytes: number;
  wireKind: ExecutionStoreWireCommand["kind"] | null;
  dispatchedAt: number | null;
  endRequest: ReturnType<typeof beginExecutionTiming>;
  endQueue: ReturnType<typeof beginExecutionTiming>;
  endWire: ReturnType<typeof beginExecutionTiming> | null;
  endWorkerWait: ReturnType<typeof beginExecutionTiming> | null;
  wireSequence: number;
  readonly resolve: (value: ExecutionStoreValue) => void;
  readonly reject: (error: unknown) => void;
}

/** Bounded acknowledgement-based writer; queue admission is not persistence. */
export class HelarcExecutionStore implements ActionRecordPort, ActionRecoveryRecordPort, RunCommitPort, CompositeCommitPort, RunTreeCommitPort, AgentHookRecordPort, ProcessRecordPort, ShellSessionRecordPort, ExecutionEvidenceRecordPort, FileMaterialRecordPort {
  private readonly queue: PendingRequest[] = [];
  private flight: PendingRequest | null = null;
  private bytes = 0;
  private nextId = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failure: string | null = null;
  private failureCause: unknown;
  private closing: Promise<void> | null = null;
  private closed = false;
  private readonly activeRoots = new Set<string>();
  private readonly stagedContent = new Set<string>();
  private readonly contentCache = new ExecutionContentCache();
  private readonly contentEncoder: ExecutionContentEncoder;
  private readonly exited: Promise<void>;
  private readonly environments: ExecutionEnvironmentProtection;
  private readonly workerTimings = new Map<string, {event: ExecutionPerformanceEvent; receivedAt: number}>();

  private constructor(private readonly worker: Worker, readonly generation: number, private readonly evidenceObserver?: ExecutionEvidenceObserver,
    private readonly fileMaterialObserver?: FileMaterialObserver, private readonly diagnostics?: ExecutionDiagnosticSink, environmentCipher?: ExecutionEnvironmentCipher) {
    this.contentEncoder = new ExecutionContentEncoder(undefined, new ExecutionContentStatistics(Boolean(diagnostics?.performance)));
    this.environments = new ExecutionEnvironmentProtection(environmentCipher);
    this.exited = new Promise(resolve => worker.once("exit", code => {
      this.contentCache.clear(); this.contentEncoder.clear();
      if (!this.closed) this.fail("execution_storage_acknowledgement_unknown", new Error(`Execution storage Worker exited with code ${code}.`), "storage_worker_exit");
      resolve();
    }));
    worker.on("error", error => this.fail("execution_storage_acknowledgement_unknown", error, "storage_worker_error"));
    worker.on("message", (reply: ExecutionStoreReply) => {
      if (reply.kind === "performance") {
        const event = reply.event;
        if (event.kind === "started") {
          if (this.workerTimings.size < 32) this.workerTimings.set(event.id, {event, receivedAt: performance.now()});
          if (event.stage === "storage.worker.command" && event.context.requestId === this.flight?.id) this.flight?.endWorkerWait?.();
        } else this.workerTimings.delete(event.id);
        try {this.diagnostics?.performance?.(event);} catch { /* Observation is independent. */ }
        return;
      }
      if (reply.kind === "ready" || reply.kind === "startup_failed") return;
      if (!this.flight || reply.id !== this.flight.id) {
        this.fail("execution_storage_protocol_invalid");
        return;
      }
      const request = this.flight;
      request.endWire?.(reply.kind === "rejected" ? "failed" : "ok");
      request.endWorkerWait?.();
      try {
        if (reply.kind !== "rejected" &&
            ((request.wireKind === "stage_content") !== (reply.kind === "content_staged") ||
             (request.wireKind === "read_content") !== (reply.kind === "content_blocks"))) throw new ExecutionStoreError("execution_storage_protocol_invalid");
        if (reply.kind === "content_staged") {
          if (!request.uploaded.length) throw new ExecutionStoreError("execution_storage_protocol_invalid");
          for (const id of request.uploaded) this.stagedContent.add(id);
          request.uploaded = [];
          if (this.stagedContent.size > EXECUTION_CONTENT_LIMITS.blocks) this.stagedContent.clear();
          this.sendNext(request); return;
        }
        if (reply.kind === "content_result") {
          if (request.responseRoot) throw new ExecutionStoreError("execution_storage_protocol_invalid");
          request.responseRoot = reply.root;
          request.responsePending.add(reply.root.root);
          this.readNext(request); return;
        }
        if (reply.kind === "content_blocks") {
          if (!request.responseRoot || reply.blocks.length !== request.requestedBlocks.length ||
              reply.blocks.some((block, index) => block.id !== request.requestedBlocks[index])) throw new ExecutionStoreError("execution_storage_protocol_invalid");
          request.requestedBlocks = [];
          for (const block of reply.blocks) {
            request.responseBytes += Buffer.byteLength(block.text);
            if (request.responseBytes > EXECUTION_CONTENT_LIMITS.hydratedBytes || request.responseBlocks.size >= EXECUTION_CONTENT_LIMITS.blocks) throw new ExecutionStoreError("execution_content_capacity_exceeded");
            const refs = executionContentReferences(block, this.contentCache);
            request.responseBlocks.set(block.id, block);
            request.responsePending.delete(block.id);
            for (const id of refs) if (!request.responseBlocks.has(id)) request.responsePending.add(id);
          }
          if (request.responsePending.size) { this.readNext(request); return; }
          const value = measureExecutionSync(this.diagnostics, "storage.host.expand_response", request.context,
            () => unpackExecutionContent(request.responseRoot!, id => request.responseBlocks.get(id)!, this.contentCache, true)) as ExecutionStoreValue;
          reply = {kind: "result", id: reply.id, value};
        }
      } catch (error) { this.fail("execution_storage_acknowledgement_unknown", error, "storage_content_transfer"); return; }
      this.flight = null;
      this.bytes -= request.bytes;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      if (reply.kind === "rejected") {
        request.endRequest("failed");
        const error = new ExecutionStoreError(reply.code, {cause: restoreExecutionError(reply.error)});
        this.recordFailure("storage_worker_rejected", error, request.command ?? undefined, request);
        request.reject(error);
      }
      else {
        request.endRequest();
        if (request.sourceKind === "close") this.closed = true;
        request.resolve(reply.value);
      }
      this.dispatch();
    });
  }

  static async open(directory: string, workerUrl = new URL("./ExecutionStoreWorker.js", import.meta.url), evidenceObserver?: ExecutionEvidenceObserver,
    fileMaterialObserver?: FileMaterialObserver, diagnostics?: ExecutionDiagnosticSink, environmentCipher?: ExecutionEnvironmentCipher): Promise<HelarcExecutionStore> {
    const endStartup = beginExecutionTiming(diagnostics, "storage.host.startup");
    let worker: Worker;
    try {worker = new Worker(workerUrl, { workerData: { directory, performanceDiagnostics: Boolean(diagnostics?.performance) } });}
    catch (error) {endStartup("failed"); throw error;}
    const store = await new Promise<HelarcExecutionStore>((resolve, reject) => {
      const timer = setTimeout(() => failed(new ExecutionStoreError("execution_storage_start_timeout")), EXECUTION_STORE_LIMITS.acknowledgementMs);
      const cleanup = () => { clearTimeout(timer); worker.off("error", failed); worker.off("exit", prematureExit); worker.off("message", message); };
      const failed = (error: unknown) => {
        endStartup("failed");
        reportExecutionFailure(diagnostics, "storage_startup", {}, error);
        cleanup();
        void worker.terminate().then(() => reject(error), () => reject(error));
      };
      const prematureExit = () => failed(new ExecutionStoreError("execution_storage_start_failed"));
      const message = (reply: ExecutionStoreReply) => {
        if (reply.kind === "startup_failed") { failed(new ExecutionStoreError(reply.code, {cause: restoreExecutionError(reply.error)})); return; }
        if (reply.kind !== "ready") { failed(new ExecutionStoreError("execution_storage_protocol_invalid")); return; }
        const store = new HelarcExecutionStore(worker, reply.generation, evidenceObserver, fileMaterialObserver, diagnostics, environmentCipher);
        endStartup();
        cleanup();
        resolve(store);
      };
      worker.once("error", failed);
      worker.once("exit", prematureExit);
      worker.once("message", message);
    });
    try {
      // Product delivery and bounded material release can be interrupted separately.
      for (const entry of await store.listProductRuns()) {
        if (entry.terminal && entry.delivered) await store.finalizeFileMaterials(entry.admission.rootRunId);
      }
      return store;
    } catch (error) {
      await store.close().catch(() => undefined);
      throw error;
    }
  }

  recordPreparedAction(value: Parameters<ActionRecordPort["recordPreparedAction"]>[0]): Promise<ExecutionRecordReceipt> {
    return this.record({kind: "prepared_action", value});
  }
  recordPreEffect(value: Parameters<ActionRecordPort["recordPreEffect"]>[0]): Promise<ExecutionRecordReceipt> {
    return this.record({ kind: "preparation", value });
  }
  async reserveFileMaterial(preparation: FileMaterialPreparation): Promise<FileMaterialReservation> {
    await this.expireFileMaterials(new Date().toISOString());
    const result = await this.request({kind: "file_material", command: {kind: "reserve", preparation: snapshotFileMaterialPreparation(preparation)}}) as FileMaterialReservation;
    if (result.status === "reserved") this.observeMaterial({kind: "reserved", record: result.record, occurredAt: new Date().toISOString()});
    return result;
  }
  async appendFileMaterial(reference: ExecutionEvidenceRef<"material">, offset: number, base64: string): Promise<void> {
    await this.request({kind: "file_material", command: {kind: "append", reference, offset, base64}});
  }
  async publishFileMaterial(reference: ExecutionEvidenceRef<"material">, digest: string, at: string): Promise<FileMaterialRecord> {
    const record = await this.request({kind: "file_material", command: {kind: "publish", reference, digest, at}}) as FileMaterialRecord;
    this.observeMaterial({kind: "published", record, occurredAt: at}); return record;
  }
  async readFileMaterialRecord(reference: ExecutionEvidenceRef<"material">): Promise<FileMaterialRecord | null> {
    return await this.request({kind: "file_material", command: {kind: "read", reference}}) as FileMaterialRecord | null;
  }
  async readFileMaterialRange(reference: ExecutionEvidenceRef<"material">, offset: number, length: number): Promise<FileMaterialRead> {
    return await this.request({kind: "file_material", command: {kind: "read_range", reference, offset, length}}) as FileMaterialRead;
  }
  async abortFileMaterial(reference: ExecutionEvidenceRef<"material">, reason: string, at: string): Promise<void> {
    const record = await this.request({kind: "file_material", command: {kind: "abort", reference, reason, at}}) as FileMaterialRecord;
    this.observeMaterial({kind: "aborted", record, occurredAt: at});
  }
  async pinFileMaterial(reference: ExecutionEvidenceRef<"material">, ownerId: string): Promise<void> {
    const record = await this.request({kind: "file_material", command: {kind: "pin", reference, ownerId}}) as FileMaterialRecord;
    this.observeMaterial({kind: "pinned", record, occurredAt: new Date().toISOString()});
  }
  async releaseFileMaterial(reference: ExecutionEvidenceRef<"material">, ownerId: string, at: string): Promise<void> {
    const record = await this.request({kind: "file_material", command: {kind: "release", reference, ownerId, at}}) as FileMaterialRecord;
    this.observeMaterial({kind: "released", record, occurredAt: at});
  }
  async expireFileMaterials(at: string): Promise<number> {
    let expired = 0;
    for (let batch = 0; batch < Math.ceil(FILE_MATERIAL_POLICY.maxManifests / FILE_MATERIAL_POLICY.expiryBatchSize); batch++) {
      const records = await this.request({kind: "file_material", command: {kind: "expire", at}}) as readonly FileMaterialRecord[];
      for (const record of records) this.observeMaterial({kind: "expired", record, occurredAt: at});
      expired += records.length;
      if (records.length < FILE_MATERIAL_POLICY.expiryBatchSize) break;
    }
    return expired;
  }
  private observeMaterial(value: FileMaterialObservation): void {
    try {this.fileMaterialObserver?.observe(value);} catch { /* Independent observation never revokes durable material. */ }
  }
  async commitExecutionEvidence(record: ExecutionEvidenceRecord): Promise<void> {
    const saved = snapshotExecutionEvidence(record);
    await this.request({kind: "commit_execution_evidence", record: saved});
    this.observeEvidence({kind: "evidence_committed", record: saved});
  }
  async commitExecutionReferenceTransfer(input: ExecutionReferenceTransfer): Promise<void> {
    const transfer = snapshotExecutionReferenceTransfer(input);
    await this.request({kind: "commit_reference_transfer", transfer});
    try {this.evidenceObserver?.observe({kind: "references_transferred", transfer});} catch { /* Observation is independent. */ }
  }
  async readExecutionReferenceTransfers(runId: string): Promise<readonly ExecutionReferenceTransfer[]> {
    return await this.request({kind: "read_reference_transfers", runId}) as readonly ExecutionReferenceTransfer[];
  }
  async readRunExecutionReferences(runId: string, after: string | null, limit: number): Promise<ExecutionReferencePage> {
    return await this.request({kind: "read_run_execution_refs", runId, after, limit}) as ExecutionReferencePage;
  }
  async readExecutionEvidence(reference: ExecutionEvidenceRef): Promise<ExecutionEvidenceRecord | null> {
    return await this.request({kind: "read_execution_evidence", reference}) as ExecutionEvidenceRecord | null;
  }
  async commitCompensationAssociation(association: CompensationAssociation): Promise<void> {
    const saved = snapshotCompensationAssociation(association);
    await this.request({kind: "commit_compensation_association", association: saved});
    this.observeEvidence({kind: "compensation_intent_committed", association: saved});
  }
  async readCompensationAssociation(invocationId: string): Promise<CompensationAssociation | null> {
    return await this.request({kind: "read_compensation_association", invocationId}) as CompensationAssociation | null;
  }
  private observeEvidence(value: ExecutionEvidenceObservation): void {
    try { this.evidenceObserver?.observe(value); } catch { /* Observation does not revoke an acknowledged owner commit. */ }
  }
  acquireRun(rootRunId: string): () => void {
    if (this.failure || this.closed || this.closing) throw new ExecutionStoreError("execution_store_closed");
    if (this.activeRoots.has(rootRunId)) throw new ExecutionStoreError("execution_run_already_active");
    this.activeRoots.add(rootRunId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRoots.delete(rootRunId);
    };
  }
  retainCommandEnvironment(snapshot: CommandEnvironmentRecoverySnapshot): RetainedCommandEnvironment {
    return this.environments.retainSnapshot(snapshot);
  }
  restoreCommandEnvironment(snapshot: RetainedCommandEnvironment): CommandEnvironmentRecoverySnapshot {
    return this.environments.restoreSnapshot(snapshot);
  }
  async admitProductRun(admission: HelarcExecutionAdmission): Promise<void> {
    await this.request({kind: "admit_product_run", admission});
  }
  async readProductRun(rootRunId: string): Promise<HelarcExecutionAdmission | null> {
    return await this.request({kind: "read_product_run", rootRunId}) as HelarcExecutionAdmission | null;
  }
  async listProductRuns(): Promise<readonly HelarcExecutionDiscovery[]> {
    return await this.request({kind: "list_product_runs"}) as readonly HelarcExecutionDiscovery[];
  }
  async listRetentionPins(): Promise<readonly import("./ExecutionStoreProtocol.js").ExecutionRetentionPin[]> {
    return await this.request({kind: "list_retention_pins"}) as readonly import("./ExecutionStoreProtocol.js").ExecutionRetentionPin[];
  }
  async commitProductDelivery(rootRunId: string): Promise<void> {
    await this.request({kind: "commit_product_delivery", rootRunId});
    await this.finalizeFileMaterials(rootRunId);
  }
  async finalizeFileMaterials(rootRunId: string): Promise<void> {
    const at = new Date().toISOString();
    let after: string | null = null;
    do {
      const page = await this.request({kind: "finalize_file_materials", rootRunId, after, at}) as import("./ExecutionStoreProtocol.js").FileMaterialFinalizationPage;
      for (const record of page.records) this.observeMaterial({kind: record.state === "aborted" ? "aborted" : "released", record, occurredAt: at});
      after = page.next;
    } while (after !== null);
  }
  async commitProcess(checkpoint: ProcessCheckpoint): Promise<void> {
    await this.request({kind: "commit_process", checkpoint: {...checkpoint,
      input: {...checkpoint.input, environment: this.environments.protect(checkpoint.input.environment)}}});
  }
  async commitShellSession(commit: ShellSessionCommit): Promise<void> {
    await this.request({kind: "commit_shell_session", commit});
  }
  async readShellSession(runId: string): Promise<ShellSessionCommit | null> {
    return await this.request({kind: "read_shell_session", runId}) as ShellSessionCommit | null;
  }
  async readProcesses(runId: string): Promise<readonly ProcessCheckpoint[]> {
    const records = await this.request({kind: "read_processes", runId}) as readonly StoredProcessCheckpoint[];
    return records.map(record => ({...record, input: {...record.input, environment: this.environments.restore(record.input.environment)}}));
  }
  async readHookInvocation(id: string): Promise<AgentHookInvocationCheckpoint | null> {
    return await this.request({kind: "read_hook", id}) as AgentHookInvocationCheckpoint | null;
  }
  async commitHookInvocation(checkpoint: AgentHookInvocationCheckpoint): Promise<void> {
    await this.request({kind: "commit_hook", checkpoint});
  }
  async listUnsettledHooks(): Promise<readonly AgentHookInvocationCheckpoint[]> {
    return await this.request({kind: "list_unsettled_hooks"}) as readonly AgentHookInvocationCheckpoint[];
  }
  recordDispatchIntent(value: Parameters<ActionRecordPort["recordDispatchIntent"]>[0]): Promise<ExecutionRecordReceipt> {
    return this.record({ kind: "dispatch_intent", value });
  }
  recordAttemptResult(value: Parameters<ActionRecordPort["recordAttemptResult"]>[0]): Promise<ExecutionRecordReceipt> {
    return this.record({ kind: "attempt_result", value });
  }
  recordPostEffect(value: Parameters<ActionRecordPort["recordPostEffect"]>[0]): Promise<ExecutionRecordReceipt> {
    return this.record({ kind: "settlement", value });
  }
  recordRetry(value: Parameters<ActionRecordPort["recordRetry"]>[0]): Promise<ExecutionRecordReceipt> {
    return this.record({kind: "retry", value});
  }
  async readAction(input: Parameters<ActionRecoveryRecordPort["readAction"]>[0]): Promise<ActionRecoveryRecords> {
    return await this.request({ kind: "read_action", runId: input.runId, actionId: input.action.id }) as ActionRecoveryRecords;
  }
  async readReceipt(recordId: string): Promise<ExecutionRecordReceipt | null> {
    return await this.request({ kind: "read_receipt", recordId }) as ExecutionRecordReceipt | null;
  }

  async commitRun(value: RunCommit): Promise<RunCommitReceipt> {
    return await this.request({kind: "commit_owner", commit: {kind: "run", value}}) as RunCommitReceipt;
  }
  async commitRunTree(commit: RunTreeCommit): Promise<RunTreeCommitReceipt> {
    return await this.request({kind: "commit_run_tree", commit}) as RunTreeCommitReceipt;
  }
  async readRunTreeCommit(recordId: string): Promise<RunTreeCommit | null> {
    return await this.request({kind: "read_run_tree_commit", recordId}) as RunTreeCommit | null;
  }
  async readLatestRunTree(rootRunId: string): Promise<RunTreeCommit | null> {
    return await this.request({kind: "read_run_tree_latest", rootRunId}) as RunTreeCommit | null;
  }
  async readRunTree(rootRunId: string): Promise<RunTreeRecoveryRecords | null> {
    return await this.request({kind: "read_run_tree", rootRunId}) as RunTreeRecoveryRecords | null;
  }
  async readRunCommit(recordId: string): Promise<RunCommit | null> {
    const result = await this.request({kind: "read_owner_commit", recordId}) as ExecutionOwnerCommit | null;
    if (result && result.kind !== "run") throw new ExecutionStoreError("execution_commit_owner_mismatch");
    return result?.value ?? null;
  }
  async readLatestRun(runId: string): Promise<RunCommit | null> {
    const result = await this.request({kind: "read_owner_latest", owner: "run", ownerId: runId}) as Extract<ExecutionOwnerCommit, {kind: "run"}> | null;
    return result?.value ?? null;
  }
  async commitComposite(value: CompositeCommit): Promise<RunCommitReceipt> {
    return await this.request({kind: "commit_owner", commit: {kind: "composite", value}}) as RunCommitReceipt;
  }
  async readCompositeCommit(recordId: string): Promise<CompositeCommit | null> {
    const result = await this.request({kind: "read_owner_commit", recordId}) as ExecutionOwnerCommit | null;
    if (result && result.kind !== "composite") throw new ExecutionStoreError("execution_commit_owner_mismatch");
    return result?.value ?? null;
  }
  async readLatestComposite(compositeId: string): Promise<CompositeCommit | null> {
    const result = await this.request({kind: "read_owner_latest", owner: "composite", ownerId: compositeId}) as ExecutionOwnerCommit | null;
    if (result && result.kind !== "composite") throw new ExecutionStoreError("execution_commit_owner_mismatch");
    return result?.value ?? null;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Close joins the same queue, after all already accepted records.
    const end = beginExecutionTiming(this.diagnostics, "storage.host.close", {generation: this.generation});
    this.closing = this.request({ kind: "close" }, true).then(async () => {
      await this.exited;
      end();
    }, async error => {
      await this.worker.terminate();
      await this.exited;
      end("failed");
      throw error;
    });
    return this.closing;
  }

  private async record(record: ActionOwnerRecord): Promise<ExecutionRecordReceipt> {
    return await this.request({ kind: "record_action", record }) as ExecutionRecordReceipt;
  }
  private request(command: ExecutionStoreCommand, closing = false): Promise<ExecutionStoreValue> {
    if (this.failure || this.closed || this.closing) return Promise.reject(new ExecutionStoreError(this.failure ?? "execution_store_closed", {cause: this.failureCause}));
    let packed: ReturnType<ExecutionContentEncoder["pack"]>;
    const id = ++this.nextId;
    const context = {...commandContext(command), generation: this.generation, requestId: id, workerThreadId: this.worker.threadId};
    const endRequest = beginExecutionTiming(this.diagnostics, "storage.host.request", context);
    const endEncoding = beginExecutionTiming(this.diagnostics, "storage.host.encode", context);
    try { packed = this.contentEncoder.pack(command); endEncoding("ok", this.contentEncoder.statistics.take()); }
    catch (error) { endEncoding("failed", this.contentEncoder.statistics.take()); endRequest("failed"); this.recordFailure("storage_request_encoding", error, command); throw error; }
    // Logical accounting conservatively admits small wire messages. Large requests
    // already have an owned content representation; do not clone their full history.
    const large = packed.bytes > EXECUTION_CONTENT_LIMITS.blockBytes / 2;
    const bytes = packed.bytes + (large ? packed.blocks.reduce((sum, block) => sum + Buffer.byteLength(block.text), 0) : 0);
    const reject = (code: string) => {
      const error = new ExecutionStoreError(code);
      endRequest("failed");
      this.recordFailure("storage_request_admission", error, command, null, bytes);
      return Promise.reject(error);
    };
    if (!closing && (this.queue.length + Number(this.flight !== null) >= EXECUTION_STORE_LIMITS.pendingRequests || this.bytes + bytes > EXECUTION_STORE_LIMITS.pendingBytes)) {
      return reject("execution_storage_capacity_exceeded");
    }
    let wireCommand: ExecutionStoreCommand | null;
    try {wireCommand = large ? null : measureExecutionSync(this.diagnostics, "storage.host.clone_wire", context,
      () => JSON.parse(JSON.stringify(command)) as ExecutionStoreCommand);}
    catch (error) {endRequest("failed"); throw error;}
    return new Promise((resolve, reject) => {
      this.bytes += bytes;
      this.queue.push({ id, bytes, command: wireCommand,
        sourceKind: command.kind, context,
        content: large ? {format: 1, root: packed.root} : null, upload: large ? packed.blocks : [],
        uploadOffset: 0, uploaded: [], responseRoot: null, responseBlocks: new Map(), responsePending: new Set(), requestedBlocks: [], responseBytes: 0, wireKind: null,
        dispatchedAt: null, endRequest, endQueue: beginExecutionTiming(this.diagnostics, "storage.host.queue", {...context, pendingRequests: this.queue.length, pendingBytes: this.bytes}),
        endWire: null, endWorkerWait: null, wireSequence: 0, resolve, reject });
      this.dispatch();
    });
  }
  private dispatch(): void {
    if (this.flight || this.failure || this.closed) return;
    const request = this.queue.shift();
    if (!request) return;
    this.flight = request;
    request.endQueue();
    request.dispatchedAt = performance.now();
    this.sendNext(request);
  }
  private sendNext(request: PendingRequest): void {
    const batch: ExecutionContentBlock[] = [];
    let bytes = 0;
    while (request.uploadOffset < request.upload.length) {
      const block = request.upload[request.uploadOffset]!;
      if (this.stagedContent.has(block.id)) { request.uploadOffset++; continue; }
      const size = Buffer.byteLength(JSON.stringify(block));
      if (bytes + size > EXECUTION_CONTENT_LIMITS.transferBytes) break;
      batch.push(block); bytes += size; request.uploadOffset++;
    }
    if (batch.length) {
      request.uploaded = batch.map(block => block.id);
      this.sendWire(request, {kind: "stage_content", blocks: batch});
    } else this.sendWire(request, request.content ? {kind: "invoke_content", root: request.content} : request.command!);
  }
  private readNext(request: PendingRequest): void {
    request.requestedBlocks = [...request.responsePending].slice(0, 16);
    this.sendWire(request, {kind: "read_content", ids: request.requestedBlocks});
  }
  private sendWire(request: PendingRequest, command: ExecutionStoreWireCommand): void {
    request.wireKind = command.kind;
    const context = {...request.context, wireKind: command.kind, wireSequence: ++request.wireSequence, requestBytes: request.bytes, contentBlocks: request.upload.length};
    request.endWire = beginExecutionTiming(this.diagnostics, "storage.host.round_trip", context);
    request.endWorkerWait = beginExecutionTiming(this.diagnostics, "storage.host.worker_start_wait", context);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail("execution_storage_acknowledgement_unknown", undefined, "storage_acknowledgement_timeout"), EXECUTION_STORE_LIMITS.acknowledgementMs);
    try { this.worker.postMessage({ id: request.id, generation: this.generation, command }); }
    catch (error) { this.fail("execution_storage_acknowledgement_unknown", error, "storage_dispatch"); }
  }
  private fail(code: string, cause?: unknown, stage = "storage_protocol"): void {
    if (this.failure) return;
    this.failure = code;
    const error = new ExecutionStoreError(code, cause === undefined ? undefined : {cause});
    this.failureCause = error;
    this.recordFailure(stage, error, this.flight?.command ?? undefined, this.flight);
    for (const {event, receivedAt} of this.workerTimings.values()) {
      try {this.diagnostics?.performance?.({...event, kind: "finished", durationMs: performance.now() - receivedAt,
        context: {...event.context, timingBasis: "host_elapsed_since_worker_start_received"},
        occurredAt: new Date().toISOString(), outcome: "unknown"});} catch { /* Observation is independent. */ }
    }
    this.workerTimings.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flight?.endWire?.("unknown"); this.flight?.endWorkerWait?.("unknown"); this.flight?.endRequest("unknown");
    this.flight?.reject(error);
    this.flight = null;
    for (const pending of this.queue.splice(0)) {
      pending.endQueue("failed"); pending.endRequest("failed");
      pending.reject(new ExecutionStoreError("execution_storage_not_dispatched", {cause: error}));
    }
    this.bytes = 0;
    void this.worker.terminate();
  }

  private recordFailure(stage: string, error: unknown, command?: ExecutionStoreCommand, request: PendingRequest | null = null, bytes?: number): void {
    try {
      reportExecutionFailure(this.diagnostics, stage, {
        ...(request?.context ?? commandContext(command)), generation: this.generation, requestId: request?.id ?? null,
        requestBytes: request?.bytes ?? bytes ?? null, pendingRequests: this.queue.length,
        pendingBytes: this.bytes, acknowledgementMs: EXECUTION_STORE_LIMITS.acknowledgementMs,
        elapsedMs: request?.dispatchedAt == null ? null : Math.round(performance.now() - request.dispatchedAt),
        contentRoot: request?.content?.root ?? null, contentBlocks: request?.upload.length ?? null,
        uploadedBlocks: request?.uploadOffset ?? null, responseContentRoot: request?.responseRoot?.root ?? null,
        receivedContentBlocks: request?.responseBlocks.size ?? null,
        transferOperation: request?.wireKind ?? null,
      }, error);
    } catch { /* A malformed request must retain its original failure. */ }
  }
}

function commandContext(command?: ExecutionStoreCommand): ExecutionDiagnosticContext {
  if (!command) return {};
  const base = {command: command.kind};
  const run = command.kind === "commit_run_tree" ? command.commit.runs[0]
    : command.kind === "commit_owner" && command.commit.kind === "run" ? command.commit.value : null;
  if (run) return {...base, runId: run.state.run.id, commitId: run.id, revision: run.state.revision,
    expectedRevision: run.expectedRevision, controllerTurnId: run.control.controllerInvocation?.turn.id ?? null,
    controllerStatus: run.control.controllerInvocation?.status ?? null,
    treeCommitId: command.kind === "commit_run_tree" ? command.commit.id : null};
  if (command.kind === "commit_run_tree") return {...base, treeCommitId: command.commit.id, runId: command.commit.checkpoint.input.rootRunId};
  if ("runId" in command) return {...base, runId: command.runId};
  if ("rootRunId" in command) return {...base, runId: command.rootRunId};
  if ("recordId" in command) return {...base, recordId: command.recordId};
  if (command.kind === "file_material") return {...base, materialOperation: command.command.kind};
  return base;
}
