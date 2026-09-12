import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_INSPECTION_CAPTURE_POLICY, captureClassEnabled, redactInspectionContent, validateInspectionCapturePolicy, type InspectionCapturePolicy } from "../content/index.js";
import { atomicInspectionJson, containedInspectionPath, defaultInspectionRoot, type InspectionDatasetManifest, type InspectionSource } from "../sources/index.js";
import type { InspectionRecord, InspectionRecordInput, InspectionSubjectRef, InspectionCoverage } from "../records/index.js";
import { snapshotInspectionJson, validateInspectionInput } from "../records/InspectionValidation.js";
import type { InspectionContentWrite } from "../storage/index.js";
import type { InspectionOffer, RecorderCommand, RecorderReply } from "./InspectionRecorderProtocol.js";

export interface InspectionRecorderOptions { readonly root?: string; readonly application: string; readonly name: string; readonly policy?: InspectionCapturePolicy }
export interface InspectionRecorderHealth { readonly available: boolean; readonly queued: number; readonly dropped: number; readonly rejected: number; readonly code: string | null; readonly coverage: InspectionCoverage | null }

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
  private dropped = 0;
  private rejected = 0;
  private closed = false;
  private failure: string | null = null;
  private coverage: InspectionCoverage | null = null;
  private requestId = 0;
  private readonly completions = new Map<number, () => void>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(private readonly worker: Worker, ready: Extract<RecorderReply, { kind: "ready" }>, policy: InspectionCapturePolicy, private readonly root: string) {
    this.source = ready.source;
    this.manifest = ready.manifest;
    this.policy = { ...policy };
    worker.on("message", (reply: RecorderReply) => {
      if (reply.kind === "failed") this.fail(reply.code);
      if (reply.kind === "ack") {
        this.coverage = reply.coverage;
        for (const offer of this.flight) { this.queueBytes -= offer.bytes; this.pendingContentBytes -= contentBytes(offer); }
        this.flight = []; this.inFlight = false; this.dispatch();
      }
      if (reply.kind === "flushed") { this.coverage = reply.coverage; this.completions.get(reply.id)?.(); this.completions.delete(reply.id); }
    });
    worker.on("error", () => this.fail("inspection_worker_failed"));
    worker.on("exit", () => { if (!this.closed) this.fail("inspection_worker_exited"); });
    worker.unref();
  }

  static async create(options: InspectionRecorderOptions): Promise<InspectionRecorder> {
    const policy = validateInspectionCapturePolicy(options.policy ?? DEFAULT_INSPECTION_CAPTURE_POLICY);
    const worker = new Worker(new URL("./InspectionRecorderWorker.js", import.meta.url), { workerData: { root: options.root ?? defaultInspectionRoot(), application: options.application, name: options.name, policy } });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { void worker.terminate(); reject(new Error("inspection_start_timeout")); }, 5000);
      worker.once("error", () => { clearTimeout(timeout); reject(new Error("inspection_worker_failed")); });
      worker.once("message", (reply: RecorderReply) => {
        clearTimeout(timeout);
        if (reply.kind !== "ready") { void worker.terminate(); reject(new Error("inspection_storage_unavailable")); return; }
        resolve(new InspectionRecorder(worker, reply, policy, options.root ?? defaultInspectionRoot()));
      });
    });
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
  health(): InspectionRecorderHealth { return { available: !this.failure && !this.closed, queued: this.queue.length + this.flight.length, dropped: this.dropped, rejected: Math.max(this.rejected, this.coverage?.rejected ?? 0), code: this.failure, coverage: this.coverage }; }

  offer(input: InspectionRecordInput): boolean {
    if (this.closed || this.failure || !this.policy.enabled) return false;
    try {
      assertDataObject(input);
      const { contents = [], ...structure } = input;
      if (!Array.isArray(contents) || contents.length > 32) throw new Error("inspection_content_invalid");
      assertDataObject(contents);
      const copy = snapshotInspectionJson(structure) as unknown as InspectionRecordInput;
      validateInspectionInput(copy);
      if (copy.subject.sourceId !== this.source.sourceId || copy.subject.datasetId !== this.manifest.datasetId) throw new Error("inspection_scope_mismatch");
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
      if (structuralBytes > 64 * 1024) throw new Error("inspection_record_oversized");
      const retained = contentWrites.reduce((sum, content) => sum + content.descriptor.retainedBytes, 0);
      if (this.queue.length + this.flight.length >= 4096 || this.queueBytes + structuralBytes > 16 * 1024 * 1024 || this.pendingContentBytes + retained > 32 * 1024 * 1024) { this.dropped++; return false; }
      this.queue.push({ record, contents: contentWrites, bytes: structuralBytes });
      this.queueBytes += structuralBytes; this.pendingContentBytes += retained;
      if (this.queue.length >= 100) this.dispatch();
      else if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = null; this.dispatch(); }, 50);
      return true;
    } catch { this.rejected++; return false; }
  }

  private dispatch(): void {
    if (this.inFlight || this.queue.length === 0 || this.failure) return;
    const offers = this.queue.splice(0, 100);
    this.flight = offers;
    this.inFlight = true;
    this.post({ kind: "batch", offers, dropped: this.dropped, rejected: this.rejected });
  }
  private post(message: RecorderCommand): void { try { this.worker.postMessage(message); } catch { this.fail("inspection_worker_failed"); } }
  private fail(code: string): void {
    if (this.failure) return;
    this.failure = code;
    this.dropped += this.queue.length + this.flight.length;
    this.queue = []; this.flight = []; this.queueBytes = 0; this.pendingContentBytes = 0;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const complete of this.completions.values()) complete();
    this.completions.clear();
  }

  async flush(close = false): Promise<void> {
    if (this.closed) return;
    if (this.failure) {
      if (close) { this.closed = true; if (this.flushTimer) clearTimeout(this.flushTimer); await this.worker.terminate(); }
      return;
    }
    if (close) this.closed = true;
    const deadline = Date.now() + 2000;
    this.dispatch();
    while ((this.queue.length || this.inFlight) && !this.failure && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.queue.length || this.inFlight) {
      if (!close) return;
      this.fail("inspection_flush_timeout");
    }
    if (!this.failure) {
      const id = ++this.requestId;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.completions.delete(id); if (close) this.fail("inspection_flush_timeout"); resolve(); }, Math.max(1, deadline - Date.now()));
        this.completions.set(id, () => { clearTimeout(timer); resolve(); });
        this.post({ kind: "flush", id, close, dropped: this.dropped, rejected: this.rejected });
      });
    }
    if (close) { if (this.flushTimer) clearTimeout(this.flushTimer); await this.worker.terminate(); }
  }
}

function assertDataObject(value: object): void {
  if (!value || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null && !Array.isArray(value))) throw new Error("inspection_content_invalid");
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !Object.hasOwn(descriptor, "value"))) throw new Error("inspection_accessor_rejected");
}
function contentBytes(offer: InspectionOffer): number { return offer.contents.reduce((sum, content) => sum + content.descriptor.retainedBytes, 0); }
