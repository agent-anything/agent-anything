import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { atomicInspectionJson, registerInspectionSource, datasetDirectory, containedInspectionPath, type InspectionDatasetManifest } from "../sources/index.js";
import { validateInspectionCapturePolicy } from "../content/index.js";
import { InspectionDatabase, type InspectionTelemetryWrite } from "../storage/index.js";
import { InspectionStorageMaintenance } from "../storage/InspectionStorageMaintenance.js";
import { InspectionStorageUsage } from "../storage/InspectionStorageUsage.js";
import { INSPECTION_STORAGE_POLICY } from "../storage/InspectionStoragePolicy.js";
import { closeFailedInspectionRecording } from "./InspectionRecordingFinalization.js";
import { InspectionTelemetry } from "../telemetry/index.js";
import type { RecorderCommand, RecorderReply } from "./InspectionRecorderProtocol.js";
import { inspectionRecorderFailureCode } from "./InspectionRecorderError.js";
import { INSPECTION_FORMAT_VERSION, type InspectionCoverage } from "../records/index.js";

const port = parentPort!;
const send = (reply: RecorderReply) => port.postMessage(reply);
let db: InspectionDatabase;
let telemetry: InspectionTelemetry;
let manifest: InspectionDatasetManifest;
let directory: string;
let usage: InspectionStorageUsage;
let maintenance: InspectionStorageMaintenance | undefined;
let failed = false;
let closing = false;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let reconciliation: ReturnType<typeof setTimeout> | undefined;
let processing = Promise.resolve();
let projectionScheduled = false;
const barriers = new Map<number, {target: number; close: boolean; accepted: number; healthRevision: number}>();
function stopMaintenance(): void {
  clearInterval(heartbeat); clearTimeout(reconciliation); maintenance?.close();
}
function fail(error: unknown): void {
  if (failed || closing) return;
  failed = true; stopMaintenance();
  const code = inspectionRecorderFailureCode(error);
  try { if (db && manifest && directory) closeFailedInspectionRecording(db, directory, manifest, code); }
  catch { /* Unconfirmed closure remains protected; preserve the first failure. */ }
  void telemetry?.close(() => {}).catch(() => {});
  send({ kind: "failed", code });
  port.close();
}
function refreshBudget(): void { usage.refreshDatabase(directory); }
async function reconcileStorage(): Promise<void> {
  usage.beginReconciliation();
  const measurement = await maintenance!.measure({ datasetId: manifest.datasetId,
    retireBefore: new Date(Date.now() - INSPECTION_STORAGE_POLICY.retentionDays * 86400000).toISOString(),
    targetBytes: INSPECTION_STORAGE_POLICY.sourceTargetBytes });
  if (failed || closing) return;
  usage.reconcile(measurement);
  refreshBudget();
}
async function ensureBudget(additional = 0): Promise<void> {
  refreshBudget();
  if (usage.datasetBytes + additional <= INSPECTION_STORAGE_POLICY.datasetLimitBytes &&
      usage.sourceBytes + additional > INSPECTION_STORAGE_POLICY.sourceLimitBytes) await reconcileStorage();
  usage.check(additional);
}
function scheduleReconciliation(): void {
  reconciliation = setTimeout(() => {
    processing = processing.then(async () => {
      if (failed || closing) return;
      await reconcileStorage(); usage.check(); scheduleReconciliation();
    }).catch(fail);
  }, 60_000);
  reconciliation.unref();
}
try {
  let completed = 0;
  const progress = () => send({ kind: "initializing", completed: ++completed });
  const source = registerInspectionSource(workerData.root, workerData.application, workerData.name);
  progress();
  maintenance = new InspectionStorageMaintenance(workerData.root, source.sourceId);
  const measure = (retireBefore: string) => {
    let previous = 0;
    return maintenance!.measure({ retireBefore, targetBytes: INSPECTION_STORAGE_POLICY.sourceTargetBytes, progress: (count) => {
      completed += count - previous; previous = count;
      send({ kind: "initializing", completed });
    } });
  };
  const baseline = await measure(new Date(Date.now() - INSPECTION_STORAGE_POLICY.retentionDays * 86400000).toISOString());
  if (baseline.bytes >= INSPECTION_STORAGE_POLICY.sourceLimitBytes) throw new Error("inspection_storage_budget_exhausted");
  usage = new InspectionStorageUsage(baseline);
  const policyPath = containedInspectionPath(workerData.root, "sources", source.sourceId, "read-policy.json");
  atomicInspectionJson(policyPath, validateInspectionCapturePolicy(workerData.policy));
  manifest = { formatVersion: INSPECTION_FORMAT_VERSION, sourceId: source.sourceId, datasetId: randomUUID(), producerInstanceId: randomUUID(), createdAt: new Date().toISOString(), status: "open" };
  directory = datasetDirectory(workerData.root, source.sourceId, manifest.datasetId);
  db = new InspectionDatabase(directory, manifest);
  atomicInspectionJson(join(directory, "manifest.json"), manifest);
  refreshBudget(); usage.check(); progress();
  telemetry = new InspectionTelemetry(source.sourceId, manifest.datasetId);
  heartbeat = setInterval(() => {
    processing = processing.then(async () => {
      if (failed || closing) return;
      await ensureBudget(); db.updateCoverage({}); refreshBudget(); usage.check();
    }).catch(fail);
  }, 5000);
  heartbeat.unref();
  scheduleReconciliation();
  send({ kind: "ready", source, manifest });
} catch (error) {
  fail(error);
  try { db!.close(); } catch { /* Initialization may have failed before opening SQLite. */ }
  port.close();
}

function scheduleProjection(): void {
  if (projectionScheduled || failed || closing) return;
  projectionScheduled = true;
  setImmediate(() => {
    processing = processing.then(async () => {
      projectionScheduled = false;
      if (failed || closing) return;
      await projectSlice();
      await finishBarriers();
      if (!failed && !closing) {
        const progress = db.snapshot().recording!;
        if (progress.projection.status === "active" && progress.projection.cursor < progress.native.target) scheduleProjection();
      }
    }).catch(fail);
  });
}

async function projectSlice(): Promise<void> {
  const progress = db.snapshot().recording!;
  if (progress.projection.status !== "active" || progress.projection.cursor >= progress.native.target) return;
  const started = performance.now();
  const records = db.records({watermark: progress.native.target, after: progress.projection.cursor, limit: 100});
  const cursor = records.length === 100 ? records.at(-1)!.commitSequence : progress.native.target;
  const exported: InspectionTelemetryWrite[] = [];
  try {
    for (const record of records) telemetry.accept(record);
    await telemetry.flush(record => exported.push(record));
    usage.check(exported.reduce((sum, record) => sum + Buffer.byteLength(record.data) * 2 + 8192, 0));
    db.recordTiming("projectionConversion", performance.now() - started);
    db.writeProjection(exported, {...progress.projection, cursor, issues: telemetry.issues}, telemetry.dropped);
    refreshBudget();
  } catch {
    // SDK pairing/export state has advanced: do not replay this slice into it.
    db.writeProjection([], {...progress.projection, status: "failed", code: "inspection_projection_failed",
      issues: telemetry.issues}, telemetry.dropped);
  } finally { db.recordTiming("projectionSlice", performance.now() - started); }
}

async function finishBarriers(): Promise<void> {
  for (const [id, barrier] of barriers) {
    let coverage: InspectionCoverage = db.snapshot();
    const projection = coverage.recording!.projection;
    if (projection.status === "active" && projection.cursor < barrier.target) continue;
    barriers.delete(id);
    db.updateCoverage({recording: {...coverage.recording!, lastFlush: {id, accepted: barrier.accepted,
      healthRevision: barrier.healthRevision, nativeTarget: barrier.target, projectionCursor: projection.cursor,
      projection: projection.status === "failed" ? "failed" : "settled"}}});
    coverage = db.snapshot();
    if (barrier.close) {
      const exported: InspectionTelemetryWrite[] = [];
      if (projection.status === "active") {
        await telemetry.close(record => exported.push(record));
        db.writeProjection(exported, {...projection, status: "closed", issues: telemetry.issues}, telemetry.dropped);
      }
      closing = true; stopMaintenance();
      db.updateCoverage({status: "closed"});
      db.checkpoint(); coverage = db.snapshot(); db.close();
      atomicInspectionJson(join(directory, "manifest.json"), {...manifest, status: "closed"});
      send({kind: "flushed", id, coverage}); port.close(); return;
    }
    send({kind: "flushed", id, coverage});
  }
}

if (!failed) port.on("message", (message: RecorderCommand) => {
  processing = processing.then(async () => {
    if (failed || closing) return;
    if (message.kind === "batch") {
      const reservation = message.offers.reduce((sum, offer) => sum + offer.bytes * 3 + 8192 +
        offer.contents.reduce((bytes, content) => bytes + content.descriptor.retainedBytes * 2, 0), 0);
      await ensureBudget(reservation);
      const receipt = db.writeNativeBatch(message.id, message.digest, message.offers, message.health);
      send({kind: "ack", receipt, coverage: db.snapshot()});
      refreshBudget(); usage.check(); scheduleProjection();
    } else if (message.kind === "health") {
      db.updateIngress(message.health);
      send({kind: "health_ack", revision: message.health.revision, coverage: db.snapshot()});
    } else if (message.kind === "receipt") {
      send({kind: "receipt", id: message.id, receipt: db.receipt(message.id), coverage: db.snapshot()});
    } else {
      if (barriers.size >= 16) { send({kind: "flush_rejected", id: message.id, code: "inspection_flush_capacity"}); return; }
      db.updateIngress(message.health);
      barriers.set(message.id, {target: db.snapshot().recording!.native.target, close: message.close, ...message.barrier});
      await finishBarriers(); scheduleProjection();
    }
  }).catch(error => { closing = false; fail(error); });
});
port.on("close", stopMaintenance);
