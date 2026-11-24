import { Worker } from "node:worker_threads";
import { types } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_INSPECTION_CAPTURE_POLICY, captureClassEnabled, redactInspectionContent, validateInspectionCapturePolicy, type InspectionCapturePolicy } from "../content/index.js";
import { atomicInspectionJson, containedInspectionPath, defaultInspectionRoot, type InspectionDatasetManifest, type InspectionSource } from "../sources/index.js";
import type { InspectionRecord, InspectionRecordInput, InspectionSubjectRef, InspectionCoverage } from "../records/index.js";
import { inspectionStructureLimit, InspectionSnapshotSizeError, snapshotInspectionJson, validateInspectionInput, validateInspectionRef } from "../records/InspectionValidation.js";
import type { InspectionAdmissionValidation } from "../records/InspectionRecordingProgress.js";
import { InspectionDatabase, type InspectionContentWrite } from "../storage/index.js";
import type { InspectionOffer, RecorderCommand, RecorderReply } from "./InspectionRecorderProtocol.js";
import { waitForInspectionReady } from "./InspectionRecorderStartup.js";
import { InspectionRecorderError } from "./InspectionRecorderError.js";
import { InspectionIngressAccounting } from "./InspectionIngressHealth.js";
import type { InspectionBatchReceipt, InspectionFlushResult } from "../records/index.js";
import { datasetDirectory } from "../sources/index.js";
import { acquireInspectionReadLease } from "../storage/InspectionDatasetAccess.js";
import { AsyncLocalStorage } from "node:async_hooks";

const batchSize=100, replayStructureLimit=16*1024*1024-65536, replayContentLimit=24*1024*1024;
type ReceiptGroup={pending:number; rejected:boolean};

export interface InspectionRecorderOptions { readonly root?: string; readonly application: string; readonly name: string; readonly policy?: InspectionCapturePolicy; readonly signal?: AbortSignal }
export interface InspectionRecorderHealth { readonly available: boolean; readonly queued: number; readonly dropped: number; readonly rejected: number; readonly code: string | null; readonly coverage: InspectionCoverage | null; readonly unpersisted: number; readonly unconfirmed: number }

export class InspectionRecorder {
  readonly source: InspectionSource;
  readonly manifest: InspectionDatasetManifest;
  private policy: InspectionCapturePolicy;
  private queue: InspectionOffer[] = [];
  private queueBytes = 0;
  private pendingContentBytes = 0;
  private flight: InspectionOffer[] = [];
  private inFlight = false;
  private captureSequence = 0;
  private readonly accounting = new InspectionIngressAccounting();
  private readonly queuedAt = new Map<number, number>();
  private batch: {id: string; digest: string; sentAt: number} | null = null;
  private acknowledged = 0;
  private readonly receiptScope=new AsyncLocalStorage<ReceiptGroup>();
  private readonly receiptOwners=new Map<number,ReceiptGroup>();
  private readonly changes=new Set<()=>void>();
  private unpersisted = 0;
  private healthRevision = 0;
  private healthFlight = false;
  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  private exited = false;
  private closeResult: InspectionFlushResult | null = null;
  private closingPromise: Promise<InspectionFlushResult> | null = null;
  private closed = false;
  private failure: string | null = null;
  private coverage: InspectionCoverage | null = null;
  private requestId = 0;
  private readonly completions = new Map<number, (coverage: InspectionCoverage | null, code?: string) => void>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(private readonly worker: Worker, ready: Extract<RecorderReply, { kind: "ready" }>, policy: InspectionCapturePolicy, private readonly root: string) {
    this.source = ready.source;
    this.manifest = ready.manifest;
    this.policy = { ...policy };
    worker.on("message", (reply: RecorderReply) => {
      if (reply.kind === "failed") this.fail(reply.code);
      if (reply.kind === "ack") {
        this.coverage = reply.coverage;
        if (this.acceptReceipt(reply.receipt)) this.healthRevision = Math.max(this.healthRevision, reply.coverage.recording?.ingress.revision ?? 0);
        this.dispatch();
      }
      if (reply.kind === "receipt") {
        this.coverage = reply.coverage;
        if (reply.receipt && this.acceptReceipt(reply.receipt)) this.healthRevision = Math.max(this.healthRevision, reply.coverage.recording?.ingress.revision ?? 0);
        this.dispatch();
      }
      if (reply.kind === "health_ack") { this.coverage = reply.coverage; this.healthRevision = Math.max(this.healthRevision, reply.revision); this.healthFlight = false; this.scheduleHealth(); }
      if (reply.kind === "capture_ack") this.coverage=reply.coverage;
      if (reply.kind === "flushed") { this.coverage = reply.coverage; this.completions.get(reply.id)?.(reply.coverage); this.completions.delete(reply.id); }
      if (reply.kind === "flush_rejected") { this.completions.get(reply.id)?.(null, reply.code); this.completions.delete(reply.id); }
    });
    worker.on("error", () => this.fail("inspection_worker_failed"));
    worker.on("exit", () => { this.exited = true; if (!this.closed) this.fail("inspection_worker_exited"); });
    worker.unref();
  }

  static async create(options: InspectionRecorderOptions): Promise<InspectionRecorder> {
    if (options.signal?.aborted) throw new InspectionRecorderError("inspection_start_cancelled");
    const policy = validateInspectionCapturePolicy(options.policy ?? DEFAULT_INSPECTION_CAPTURE_POLICY);
    let worker: Worker;
    try { worker = new Worker(new URL("./InspectionRecorderWorker.js", import.meta.url), { workerData: { root: options.root ?? defaultInspectionRoot(), application: options.application, name: options.name, policy } }); }
    catch { throw new InspectionRecorderError("inspection_worker_failed"); }
    const ready = await waitForInspectionReady(worker, options.signal);
    return new InspectionRecorder(worker, ready, policy, options.root ?? defaultInspectionRoot());
  }

  ref(owner: string, kind: InspectionSubjectRef["kind"], id: string, runId: string | null = null, revision: string | null = null): InspectionSubjectRef {
    return { sourceId: this.source.sourceId, datasetId: this.manifest.datasetId, owner, kind, id, runId, revision };
  }
  get capturePolicyRevision(): string { return this.policy.revision; }
  captures(kind:import("../records/index.js").InspectionContentClass):boolean {return !this.closed&&!this.failure&&captureClassEnabled(this.policy,kind);}
  setPolicy(policy: InspectionCapturePolicy): void {
    const next = validateInspectionCapturePolicy(policy);
    // A user-triggered revocation must reach the reader even when capture has failed.
    atomicInspectionJson(containedInspectionPath(this.root, "sources", this.source.sourceId, "read-policy.json"), next);
    this.policy = next;
    if(!this.closed&&!this.failure)this.post({kind:"capture_policy",policy:next});
  }
  health(): InspectionRecorderHealth {
    const health = this.accounting.snapshot();
    return {available: !this.failure && !this.closed, queued: this.queue.length + (this.failure ? 0 : this.flight.length),
      dropped: health.dropped, rejected: Math.max(health.rejected, this.coverage?.rejected ?? 0), code: this.failure,
      coverage: this.coverage, unpersisted: this.unpersisted, unconfirmed: this.failure ? this.flight.length : 0};
  }

  offer(input: InspectionRecordInput, detail?:{operation:string;stage:string}): boolean {
    if (this.closed || this.failure || !this.policy.enabled) return false;
    const started = performance.now();
    const prepared = this.prepareOffer(input);
    return prepared !== null && this.enqueue(prepared, started, detail);
  }

  historyProgress(state:"started"|"confirmed"|"incomplete"):void {
    this.accounting.history(state);this.scheduleHealth();
  }

  /** A source checkpoint depends on its own offers, not unrelated live work or telemetry. */
  async confirmNativeWork(work:()=>Promise<void>):Promise<void>{
    const group:ReceiptGroup={pending:0,rejected:false};
    await this.receiptScope.run(group,work);
    while(group.pending){
      if(this.failure||this.closed)throw new InspectionRecorderError(this.failure??"inspection_replay_unavailable");
      this.dispatch();await this.waitForReceipt(10000);
    }
    if(group.rejected)throw new InspectionRecorderError("inspection_replay_record_rejected");
  }

  private wakeReaders():void {for(const wake of this.changes)wake();}
  private waitForReceipt(ms:number,signal?:AbortSignal):Promise<void>{
    return new Promise((resolve,reject)=>{
      const done=()=>{clearTimeout(timer);this.changes.delete(done);signal?.removeEventListener("abort",done);resolve();};
      const timer=setTimeout(()=>{this.changes.delete(done);signal?.removeEventListener("abort",done);
        reject(new InspectionRecorderError("inspection_replay_capacity_timeout"));},ms);
      this.changes.add(done);signal?.addEventListener("abort",done,{once:true});
    });
  }

  /** Durable replay can wait for ingress capacity; live observation must not wait. */
  async offerWhenReady(input: InspectionRecordInput, options: { signal?: AbortSignal; timeoutMs?: number; maxPendingRecords?:number } = {}): Promise<boolean> {
    const timeoutMs = options.timeoutMs ?? 10000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError("inspection_replay_budget_invalid");
    const window=options.maxPendingRecords??batchSize;
    if(!Number.isSafeInteger(window)||window<1||window>4096)throw new TypeError("inspection_replay_window_invalid");
    const deadline = performance.now() + timeoutMs;
    let prepared: InspectionOffer | null = null;
    while (true) {
      if (options.signal?.aborted) throw new InspectionRecorderError("inspection_replay_cancelled");
      if (this.closed || this.failure || !this.policy.enabled) throw new InspectionRecorderError(this.failure ?? "inspection_replay_unavailable");
      if (!prepared || prepared.record.policyRevision !== this.policy.revision) prepared = this.prepareOffer(input);
      if (!prepared) return false;
      const bytes=contentBytes(prepared);
      if(bytes>replayContentLimit)throw new InspectionRecorderError("inspection_replay_content_exceeds_window");
      if(this.queue.length+this.flight.length<Math.min(batchSize,window)&&
        this.queueBytes+prepared.bytes<=replayStructureLimit&&this.pendingContentBytes+bytes<=replayContentLimit)return this.enqueue(prepared);
      if (performance.now() >= deadline) throw new InspectionRecorderError("inspection_replay_capacity_timeout");
      this.dispatch();
      await this.waitForReceipt(Math.max(1,deadline-performance.now()),options.signal);
    }
  }

  private prepareOffer(input: InspectionRecordInput): InspectionOffer | null {
    let stage: InspectionAdmissionValidation["stage"] = "envelope";
    try {
      assertDataObject(input);
      const { contents = [], ...structure } = input;
      if (!Array.isArray(contents) || contents.length > 32) throw new Error("inspection_content_invalid");
      assertDataObject(contents);
      stage = "structure_snapshot";
      const copy = snapshotInspectionJson(structure) as unknown as InspectionRecordInput;
      stage = "fields";
      validateInspectionInput(copy);
      stage = "scope";
      if (copy.subject.sourceId !== this.source.sourceId || copy.subject.datasetId !== this.manifest.datasetId) throw new Error("inspection_scope_mismatch");
      stage = "content";
      const id = copy.id ?? randomUUID();
      const contentWrites: InspectionContentWrite[] = contents.map((content, index) => {
        assertDataObject(content);
        if (typeof content.name !== "string" || typeof content.stage !== "string" || !["definition", "agent", "provider", "execution"].includes(content.class) || !["application/json", "text/plain"].includes(content.mediaType)) throw new Error("inspection_content_invalid");
        const enabled = captureClassEnabled(this.policy, content.class);
        let text: string | null = null;
        let redacted = false;
        let truncated = false;
        let originalBytes: number | null = null;
        if (enabled && !content.unavailableReason) {
          try {
            let candidate = snapshotInspectionJson(content.value, 8 * 1024 * 1024);
            let encodedJson = false;
            if (content.stage === "encoded_json" && typeof candidate === "string") {
              candidate = snapshotInspectionJson(JSON.parse(candidate), 8 * 1024 * 1024);
              encodedJson = true;
            }
            const value = redactInspectionContent(candidate);
            redacted = value.redacted;
            text = encodedJson && !redacted ? content.value as string : content.mediaType === "text/plain" && typeof value.value === "string" ? value.value : JSON.stringify(value.value);
            originalBytes = Buffer.byteLength(text);
          } catch { truncated = true; }
        }
        const contentId = createHash("sha256").update(`${id}:content:${index}`).digest("hex");
        return { text, descriptor: { ...(content.unavailableReason ? { unavailableReason: content.unavailableReason.slice(0, 128) } : {}), id: contentId, name: content.name.slice(0, 256), class: content.class, stage: content.stage.slice(0, 128), mediaType: content.mediaType, availability: !enabled ? "not_captured" : text === null ? "unavailable" : "present", retainedBytes: text === null ? 0 : Buffer.byteLength(text), originalBytes, digest: text === null ? null : createHash("sha256").update(text).digest("hex"), redacted, truncated } };
      });
      const record: InspectionRecord = { id, subject: copy.subject, payload: copy.payload, occurredAt: copy.occurredAt, capturedAt: new Date().toISOString(), ownerSequence: copy.ownerSequence ?? null, captureSequence: this.captureSequence + 1, commitSequence: 0, policyRevision: this.policy.revision, contents: contentWrites.map((content) => content.descriptor), links: (copy.links ?? []).map((link, index) => ({ ...link, id: createHash("sha256").update(`${id}:link:${index}`).digest("hex"), establishedBy: id })) };
      stage = "encoded_record";
      const structuralBytes = Buffer.byteLength(JSON.stringify(record));
      if (structuralBytes > inspectionStructureLimit) {
        const {subject,recordId}=rejectedIdentity(input,this.source.sourceId,this.manifest.datasetId);
        this.accounting.rejected("record_oversized",null,subject,{validation:{stage,recordId,limitBytes:inspectionStructureLimit}});
        this.scheduleHealth();return null;
      }
      return {record, contents: contentWrites, bytes: structuralBytes};
    } catch (error) {
      const {subject,recordId}=rejectedIdentity(input,this.source.sourceId,this.manifest.datasetId);
      const oversized=stage==="structure_snapshot"&&error instanceof InspectionSnapshotSizeError;
      this.accounting.rejected(oversized?"structure_oversized":"invalid_input",null,subject,
        {validation:{stage,recordId,...(oversized?{limitBytes:inspectionStructureLimit}:{})}});
      this.scheduleHealth(); return null;
    }
  }

  private capacityReason(offer: InspectionOffer): "record_capacity" | "structure_capacity" | "content_capacity" | null {
    return this.queue.length + this.flight.length >= 4096 ? "record_capacity" :
      this.queueBytes + offer.bytes > 16 * 1024 * 1024 ? "structure_capacity" :
      this.pendingContentBytes + contentBytes(offer) > 32 * 1024 * 1024 ? "content_capacity" : null;
  }

  private enqueue(offer: InspectionOffer, started = performance.now(),detail?:{operation:string;stage:string}): boolean {
    const record = {...offer.record, captureSequence: this.captureSequence+1};
    offer = {...offer, record, bytes: Buffer.byteLength(JSON.stringify(record), "utf8")};
    if (offer.bytes > inspectionStructureLimit) {
      const {subject,recordId}=rejectedIdentity(record,this.source.sourceId,this.manifest.datasetId);
      this.accounting.rejected("record_oversized",null,subject,{validation:{stage:"encoded_record",recordId,limitBytes:inspectionStructureLimit}});
      this.scheduleHealth();return false;
    }
    this.captureSequence=record.captureSequence;
    const reason = this.capacityReason(offer);
    if (reason) {this.accounting.rejected(reason, record.captureSequence, record.subject,{pending:{records:this.queue.length+this.flight.length,structureBytes:this.queueBytes,contentBytes:this.pendingContentBytes},
      ...(detail&&/^[a-z_]{1,64}$/.test(detail.operation)&&/^[a-z_]{1,32}$/.test(detail.stage)?{detail:{operation:detail.operation,stage:detail.stage}}:{})}); this.scheduleHealth(); return false;}
    const group=this.receiptScope.getStore();
    if(group){this.receiptOwners.set(record.captureSequence,group);group.pending++;}
    this.queue.push({...offer, record});
    this.queueBytes += offer.bytes; this.pendingContentBytes += contentBytes(offer);
    this.queuedAt.set(record.captureSequence, performance.now());
    this.accounting.accepted(this.queue.length + this.flight.length, this.queueBytes, this.pendingContentBytes, performance.now() - started);
    if (this.queue.length >= batchSize) this.dispatch();
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => {this.flushTimer = null; this.dispatch();}, 50);
    return true;
  }

  private dispatch(): void {
    if (this.inFlight || this.queue.length === 0 || this.failure) return;
    const offers = this.queue.splice(0, batchSize);
    this.flight = offers;
    this.inFlight = true;
    const sentAt = performance.now();
    for (const offer of offers) {
      this.accounting.timing("queueMaxMs", sentAt - this.queuedAt.get(offer.record.captureSequence)!);
      this.queuedAt.delete(offer.record.captureSequence);
    }
    this.batch = {id: randomUUID(), digest: createHash("sha256").update(JSON.stringify(offers)).digest("hex"), sentAt};
    this.post({kind: "batch", ...this.batch, offers, health: this.accounting.snapshot()});
  }
  private acceptReceipt(receipt: InspectionBatchReceipt): boolean {
    if (receipt.id !== this.batch?.id) return false;
    if (receipt.digest !== this.batch.digest || receipt.persisted + receipt.duplicates + receipt.rejected !== this.flight.length ||
        receipt.firstSequence !== this.flight[0]?.record.captureSequence || receipt.lastSequence !== this.flight.at(-1)?.record.captureSequence) {
      this.fail("inspection_receipt_invalid"); return false;
    }
    this.accounting.timing("acknowledgementMaxMs", performance.now() - this.batch.sentAt);
    const rejected=new Set(receipt.rejectedOffers.map(r=>r.sequence));
    for (const offer of this.flight) {
      this.queueBytes -= offer.bytes; this.pendingContentBytes -= contentBytes(offer);
      const seq=offer.record.captureSequence,group=this.receiptOwners.get(seq);
      if(group){group.pending--;if(rejected.has(seq)||receipt.rejected!==rejected.size)group.rejected=true;this.receiptOwners.delete(seq);}
    }
    this.acknowledged += this.flight.length;
    this.flight = []; this.inFlight = false; this.batch = null;
    this.wakeReaders();
    this.scheduleHealth();
    return true;
  }
  private scheduleHealth(): void {
    if (this.closed || this.failure || this.healthFlight || this.healthTimer || this.accounting.snapshot().revision <= this.healthRevision) return;
    this.healthTimer = setTimeout(() => {
      this.healthTimer = null;
      if (this.closed || this.failure) return;
      if (this.accounting.snapshot().revision <= this.healthRevision) return;
      this.healthFlight = true;
      this.post({kind: "health", health: this.accounting.snapshot()});
    }, 50);
    this.healthTimer.unref();
  }
  private post(message: RecorderCommand): void { try { this.worker.postMessage(message); } catch { this.fail("inspection_worker_failed"); } }
  private fail(code: string): void {
    if (this.failure) return;
    this.failure = code;
    this.wakeReaders();
    this.unpersisted += this.queue.length;
    for (const offer of this.queue) { this.queueBytes -= offer.bytes; this.pendingContentBytes -= contentBytes(offer); }
    this.queue = []; this.queuedAt.clear();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.healthTimer) clearTimeout(this.healthTimer);
    for (const complete of this.completions.values()) complete(null);
    this.completions.clear();
  }

  flush(close = false): Promise<InspectionFlushResult> {
    if (this.closingPromise) return this.closingPromise;
    if (close) return this.closingPromise = this.flushBarrier(true);
    return this.flushBarrier(false);
  }

  private async flushBarrier(close: boolean): Promise<InspectionFlushResult> {
    if (this.closeResult) return this.closeResult;
    const health = this.accounting.snapshot();
    const barrier = {accepted: health.accepted, healthRevision: health.revision};
    if (close) this.closed = true;
    const deadline = Date.now() + 2000;
    this.dispatch();
    while (this.acknowledged < barrier.accepted && !this.failure && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    let flushed: InspectionCoverage | null = null;
    let flushCode: string | null = this.completions.size >= 16 ? "inspection_flush_capacity" : null;
    if (!this.failure && this.acknowledged >= barrier.accepted && this.completions.size < 16) {
      const id = ++this.requestId;
      flushed = await new Promise<InspectionCoverage | null>((resolve) => {
        const timer = setTimeout(() => { this.completions.delete(id); resolve(null); }, Math.max(1, deadline - Date.now()));
        this.completions.set(id, (coverage, code) => { clearTimeout(timer); flushCode = code ?? null; resolve(coverage); });
        this.post({kind: "flush", id, close, health: this.accounting.snapshot(), barrier});
      });
    }
    if (!flushed && this.batch && !this.failure) this.post({kind: "receipt", id: this.batch.id});
    if (close) {
      if (!flushed && !this.failure) this.fail("inspection_flush_timeout");
      if (this.flushTimer) clearTimeout(this.flushTimer);
      if (this.healthTimer) clearTimeout(this.healthTimer);
      await this.worker.terminate(); this.exited = true;
    }
    if (this.exited && this.batch) {
      // The writer is gone. Read its durable receipt; never start a replacement writer.
      let database: InspectionDatabase | null = null;
      let release: (() => void) | null = null;
      try {
        const directory = datasetDirectory(this.root, this.source.sourceId, this.manifest.datasetId);
        release = acquireInspectionReadLease(directory);
        database = new InspectionDatabase(directory);
        const receipt = database.receipt(this.batch.id);
        this.coverage = database.snapshot();
        if (receipt) this.acceptReceipt(receipt);
        else { this.unpersisted += this.flight.length; this.flight = []; this.batch = null; }
      } catch { /* The in-flight tail remains explicitly unconfirmed. */ }
      finally { database?.close(); release?.(); }
    }
    const projection = (flushed ?? this.coverage)?.recording?.projection;
    const result: InspectionFlushResult = {barrier, native: this.acknowledged >= barrier.accepted ? "settled" : this.flight.length && this.failure ? "unknown" : this.failure ? "failed" : "pending",
      projection: projection?.status === "failed" ? "failed" : projection?.status === "incomplete" ? "incomplete" : flushed ? "settled" : this.failure ? "unknown" : "pending",
      watermark: (flushed ?? this.coverage)?.watermark ?? null, projectionCursor: projection?.cursor ?? null,
      unpersisted: this.unpersisted, unconfirmed: this.failure ? this.flight.length : 0,
      code: this.failure ?? flushCode ?? (flushed ? null : "inspection_flush_timeout")};
    if (close) this.closeResult = result;
    return result;
  }
}

function assertDataObject(value: object): void {
  if (!value || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null && !Array.isArray(value))) throw new Error("inspection_content_invalid");
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !Object.hasOwn(descriptor, "value"))) throw new Error("inspection_accessor_rejected");
}
function contentBytes(offer: InspectionOffer): number { return offer.contents.reduce((sum, content) => sum + content.descriptor.retainedBytes, 0); }

/** Read only own identity fields; rejected bodies, accessors and foreign scopes are not health data. */
function rejectedIdentity(input:unknown,sourceId:string,datasetId:string):{subject:InspectionSubjectRef|null;recordId:string|null} {
  const own=(v:unknown,k:string):unknown=>v&&typeof v==="object"&&!types.isProxy(v)?Object.getOwnPropertyDescriptor(v,k)?.value:undefined;
  const ref=own(input,"subject"),unknown={subject:null,recordId:null};
  if(own(ref,"sourceId")!==sourceId||own(ref,"datasetId")!==datasetId)return unknown;
  const subject={sourceId,datasetId,owner:own(ref,"owner"),kind:own(ref,"kind"),id:own(ref,"id"),
    revision:own(ref,"revision"),runId:own(ref,"runId")} as InspectionSubjectRef;
  try{validateInspectionRef(subject);}catch{return unknown;}
  const id=own(input,"id");
  return {subject,recordId:typeof id==="string"&&id.length>0&&id.length<=512?id:null};
}
