import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_INSPECTION_CAPTURE_POLICY, captureClassEnabled, redactInspectionContent, validateInspectionCapturePolicy, type InspectionCapturePolicy } from "../content/index.js";
import { atomicInspectionJson, containedInspectionPath, defaultInspectionRoot, type InspectionDatasetManifest, type InspectionSource } from "../sources/index.js";
import type { InspectionRecord, InspectionRecordInput, InspectionSubjectRef, InspectionCoverage } from "../records/index.js";
import { snapshotInspectionJson, validateInspectionInput } from "../records/InspectionValidation.js";
import { InspectionDatabase, type InspectionContentWrite } from "../storage/index.js";
import type { InspectionOffer, RecorderCommand, RecorderReply } from "./InspectionRecorderProtocol.js";
import { waitForInspectionReady } from "./InspectionRecorderStartup.js";
import { InspectionRecorderError } from "./InspectionRecorderError.js";
import { InspectionIngressAccounting } from "./InspectionIngressHealth.js";
import type { InspectionBatchReceipt, InspectionFlushResult } from "../records/index.js";
import { datasetDirectory } from "../sources/index.js";
import { acquireInspectionReadLease } from "../storage/InspectionDatasetAccess.js";

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
        this.acceptReceipt(reply.receipt); this.dispatch();
      }
      if (reply.kind === "receipt") { this.coverage = reply.coverage; if (reply.receipt) this.acceptReceipt(reply.receipt); this.dispatch(); }
      if (reply.kind === "health_ack") { this.coverage = reply.coverage; this.healthRevision = Math.max(this.healthRevision, reply.revision); this.healthFlight = false; this.scheduleHealth(); }
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
  setPolicy(policy: InspectionCapturePolicy): void {
    const next = validateInspectionCapturePolicy(policy);
    // A user-triggered revocation must reach the reader even when capture has failed.
    atomicInspectionJson(containedInspectionPath(this.root, "sources", this.source.sourceId, "read-policy.json"), next);
    this.policy = next;
  }
  health(): InspectionRecorderHealth {
    const health = this.accounting.snapshot();
    return {available: !this.failure && !this.closed, queued: this.queue.length + (this.failure ? 0 : this.flight.length),
      dropped: health.dropped, rejected: Math.max(health.rejected, this.coverage?.rejected ?? 0), code: this.failure,
      coverage: this.coverage, unpersisted: this.unpersisted, unconfirmed: this.failure ? this.flight.length : 0};
  }

  offer(input: InspectionRecordInput): boolean {
    if (this.closed || this.failure || !this.policy.enabled) return false;
    const started = performance.now();
    let subject: InspectionSubjectRef | null = null;
    let sequence: number | null = null;
    try {
      assertDataObject(input);
      const { contents = [], ...structure } = input;
      if (!Array.isArray(contents) || contents.length > 32) throw new Error("inspection_content_invalid");
      assertDataObject(contents);
      const copy = snapshotInspectionJson(structure) as unknown as InspectionRecordInput;
      validateInspectionInput(copy);
      if (copy.subject.sourceId !== this.source.sourceId || copy.subject.datasetId !== this.manifest.datasetId) throw new Error("inspection_scope_mismatch");
      subject = copy.subject;
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
      const record: InspectionRecord = { id, subject: copy.subject, payload: copy.payload, occurredAt: copy.occurredAt, capturedAt: new Date().toISOString(), ownerSequence: copy.ownerSequence ?? null, captureSequence: ++this.captureSequence, commitSequence: 0, policyRevision: this.policy.revision, contents: contentWrites.map((content) => content.descriptor), links: (copy.links ?? []).map((link, index) => ({ ...link, id: createHash("sha256").update(`${id}:link:${index}`).digest("hex"), establishedBy: id })) };
      const structuralBytes = Buffer.byteLength(JSON.stringify(record));
      sequence = record.captureSequence;
      if (structuralBytes > 64 * 1024) throw new Error("inspection_record_oversized");
      const retained = contentWrites.reduce((sum, content) => sum + content.descriptor.retainedBytes, 0);
      const reason = this.queue.length + this.flight.length >= 4096 ? "record_capacity" : this.queueBytes + structuralBytes > 16 * 1024 * 1024 ? "structure_capacity" : this.pendingContentBytes + retained > 32 * 1024 * 1024 ? "content_capacity" : null;
      if (reason) { this.accounting.rejected(reason, sequence, subject); this.scheduleHealth(); return false; }
      this.queue.push({ record, contents: contentWrites, bytes: structuralBytes });
      this.queueBytes += structuralBytes; this.pendingContentBytes += retained;
      this.queuedAt.set(record.captureSequence, performance.now());
      this.accounting.accepted(this.queue.length + this.flight.length, this.queueBytes, this.pendingContentBytes, performance.now() - started);
      if (this.queue.length >= 100) this.dispatch();
      else if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = null; this.dispatch(); }, 50);
      return true;
    } catch (error) {
      this.accounting.rejected(error instanceof Error && error.message === "inspection_record_oversized" ? "record_oversized" : "invalid_input", sequence, subject);
      this.scheduleHealth(); return false;
    }
  }

  private dispatch(): void {
    if (this.inFlight || this.queue.length === 0 || this.failure) return;
    const offers = this.queue.splice(0, 100);
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
  private acceptReceipt(receipt: InspectionBatchReceipt): void {
    if (receipt.id !== this.batch?.id) return;
    if (receipt.digest !== this.batch.digest || receipt.persisted + receipt.duplicates + receipt.rejected !== this.flight.length ||
        receipt.firstSequence !== this.flight[0]?.record.captureSequence || receipt.lastSequence !== this.flight.at(-1)?.record.captureSequence) {
      this.fail("inspection_receipt_invalid"); return;
    }
    this.accounting.timing("acknowledgementMaxMs", performance.now() - this.batch.sentAt);
    for (const offer of this.flight) { this.queueBytes -= offer.bytes; this.pendingContentBytes -= contentBytes(offer); }
    this.acknowledged += this.flight.length;
    this.flight = []; this.inFlight = false; this.batch = null;
    this.scheduleHealth();
  }
  private scheduleHealth(): void {
    if (this.closed || this.failure || this.healthFlight || this.healthTimer || this.accounting.snapshot().revision <= this.healthRevision) return;
    this.healthTimer = setTimeout(() => {
      this.healthTimer = null;
      if (this.closed || this.failure) return;
      this.healthFlight = true;
      this.post({kind: "health", health: this.accounting.snapshot()});
    }, 50);
    this.healthTimer.unref();
  }
  private post(message: RecorderCommand): void { try { this.worker.postMessage(message); } catch { this.fail("inspection_worker_failed"); } }
  private fail(code: string): void {
    if (this.failure) return;
    this.failure = code;
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
      projection: projection?.status === "failed" ? "failed" : flushed ? "settled" : this.failure ? "unknown" : "pending",
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
