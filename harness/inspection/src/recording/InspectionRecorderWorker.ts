import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { atomicInspectionJson, registerInspectionSource, datasetDirectory, containedInspectionPath, type InspectionDatasetManifest } from "../sources/index.js";
import { validateInspectionCapturePolicy } from "../content/index.js";
import { InspectionDatabase } from "../storage/index.js";
import { InspectionStorageMaintenance } from "../storage/InspectionStorageMaintenance.js";
import { InspectionStorageUsage } from "../storage/InspectionStorageUsage.js";
import { InspectionTelemetry } from "../telemetry/index.js";
import type { RecorderCommand, RecorderReply } from "./InspectionRecorderProtocol.js";
import { inspectionRecorderFailureCode } from "./InspectionRecorderError.js";
import { INSPECTION_FORMAT_VERSION } from "../records/index.js";

const port = parentPort!;
const send = (reply: RecorderReply) => port.postMessage(reply);
let db: InspectionDatabase;
let telemetry: InspectionTelemetry;
let manifest: InspectionDatasetManifest;
let directory: string;
let usage: InspectionStorageUsage;
let maintenance: InspectionStorageMaintenance | undefined;
let writerRejected = 0;
let pendingTelemetryBytes = 0;
let failed = false;
let closing = false;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let reconciliation: ReturnType<typeof setTimeout> | undefined;
const updateHealth = (dropped: number, rejected: number) => db.updateCoverage({ dropped, rejected: rejected + writerRejected, telemetryDropped: telemetry.dropped });
function stopMaintenance(): void {
  clearInterval(heartbeat); clearTimeout(reconciliation); maintenance?.close();
}
function fail(error: unknown): void {
  if (failed || closing) return;
  failed = true; stopMaintenance();
  const code = inspectionRecorderFailureCode(error);
  if (code === "inspection_storage_budget_exhausted") {
    try { db.updateCoverage({ limitations: [...new Set([...db.snapshot().limitations, "storage_budget_exhausted"])] }); } catch { /* Preserve the first failure. */ }
  }
  send({ kind: "failed", code });
}
function refreshBudget(): void { usage.refreshDatabase(directory); usage.check(); pendingTelemetryBytes = 0; }
function scheduleReconciliation(): void {
  reconciliation = setTimeout(() => {
    if (failed || closing) return;
    usage.beginReconciliation();
    void maintenance!.measure({ datasetId: manifest.datasetId }).then((measurement) => {
      if (failed || closing) return;
      usage.reconcile(measurement); refreshBudget(); scheduleReconciliation();
    }).catch(fail);
  }, 60_000);
  reconciliation.unref();
}
function writeTelemetry(record: Parameters<InspectionDatabase["writeTelemetry"]>[0]): void {
  const reservation = Buffer.byteLength(record.data) * 2 + 8192;
  usage.check(pendingTelemetryBytes + reservation);
  db.writeTelemetry(record);
  pendingTelemetryBytes += reservation;
}

try {
  let completed = 0;
  const progress = () => send({ kind: "initializing", completed: ++completed });
  const source = registerInspectionSource(workerData.root, workerData.application, workerData.name);
  progress();
  maintenance = new InspectionStorageMaintenance(workerData.root, source.sourceId);
  const measure = (retireBefore: string) => {
    let previous = 0;
    return maintenance!.measure({ retireBefore, progress: (count) => {
      completed += count - previous; previous = count;
      send({ kind: "initializing", completed });
    } });
  };
  let baseline = await measure(new Date(Date.now() - 7 * 86400000).toISOString());
  if (baseline.bytes >= 2047 * 1024 * 1024) {
    baseline = await measure(new Date().toISOString());
    if (baseline.bytes >= 2047 * 1024 * 1024) throw new Error("inspection_storage_budget_exhausted");
  }
  usage = new InspectionStorageUsage(baseline);
  const policyPath = containedInspectionPath(workerData.root, "sources", source.sourceId, "read-policy.json");
  atomicInspectionJson(policyPath, validateInspectionCapturePolicy(workerData.policy));
  manifest = { formatVersion: INSPECTION_FORMAT_VERSION, sourceId: source.sourceId, datasetId: randomUUID(), producerInstanceId: randomUUID(), createdAt: new Date().toISOString(), status: "open" };
  directory = datasetDirectory(workerData.root, source.sourceId, manifest.datasetId);
  db = new InspectionDatabase(directory, manifest, (path, bytes) => usage.physicalFileChanged(path, bytes));
  atomicInspectionJson(join(directory, "manifest.json"), manifest);
  refreshBudget(); progress();
  telemetry = new InspectionTelemetry(source.sourceId, manifest.datasetId);
  heartbeat = setInterval(() => {
    if (failed || closing) return;
    try { refreshBudget(); db.updateCoverage({}); refreshBudget(); } catch (error) { fail(error); }
  }, 5000);
  heartbeat.unref();
  scheduleReconciliation();
  send({ kind: "ready", source, manifest });
} catch (error) {
  fail(error);
  try { db!.close(); } catch { /* Initialization may have failed before opening SQLite. */ }
  port.close();
}

let processing = Promise.resolve();
if (!failed) port.on("message", (message: RecorderCommand) => {
  processing = processing.then(async () => {
    if (failed || closing) return;
    try {
      if (message.kind === "batch") {
        refreshBudget();
        let pendingSqlBytes = 0;
        const committedRecords: Parameters<InspectionTelemetry["accept"]>[0][] = [];
        db.writeBatch(() => {
          for (const offer of message.offers) {
            const contentBytes = offer.contents.reduce((sum, content) => sum + content.descriptor.retainedBytes, 0);
            usage.check(contentBytes + pendingSqlBytes + offer.bytes * 3 + 8192);
            try {
              const committed = db.write(offer.record, offer.contents);
              if (!committed.duplicate) {
                pendingSqlBytes += offer.bytes * 3 + 8192;
                committedRecords.push(committed.record);
              }
            } catch (error) {
              if (error instanceof Error && (error.message === "inspection_record_conflict" || error.message.startsWith("inspection_flow_"))) {
                writerRejected++;
                const coverage = db.snapshot();
                db.updateCoverage({ limitations: [...new Set([...coverage.limitations, error.message === "inspection_record_conflict" ? "conflicting_record_identity" : error.message])] });
              } else throw error;
            }
          }
          updateHealth(message.dropped, message.rejected);
        });
        refreshBudget();
        for (const record of committedRecords) telemetry.accept(record);
        const exported: Parameters<typeof writeTelemetry>[0][] = [];
        await telemetry.flush(record => exported.push(record));
        if (failed) return;
        db.writeBatch(() => { for (const record of exported) writeTelemetry(record); });
        refreshBudget();
        send({ kind: "ack", coverage: db.snapshot() });
      } else {
        if (message.close) await telemetry.close(writeTelemetry);
        else await telemetry.flush(writeTelemetry);
        if (failed) return;
        updateHealth(message.dropped, message.rejected);
        if (message.close) {
          closing = true; stopMaintenance();
          db.updateCoverage({ status: "closed" });
          atomicInspectionJson(join(directory, "manifest.json"), { ...manifest, status: "closed" });
          db.checkpoint();
        }
        refreshBudget();
        send({ kind: "flushed", id: message.id, coverage: db.snapshot() });
        if (message.close) { db.close(); port.close(); }
      }
    } catch (error) { closing = false; fail(error); }
  });
});
port.on("close", stopMaintenance);
