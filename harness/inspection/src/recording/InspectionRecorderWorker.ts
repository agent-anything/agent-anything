import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { atomicInspectionJson, registerInspectionSource, datasetDirectory, containedInspectionPath, type InspectionDatasetManifest } from "../sources/index.js";
import { validateInspectionCapturePolicy } from "../content/index.js";
import { InspectionDatabase, inspectionSourceBytes, retireInspectionDatasets } from "../storage/index.js";
import { InspectionTelemetry } from "../telemetry/index.js";
import type { RecorderCommand, RecorderReply } from "./InspectionRecorderProtocol.js";

const port = parentPort!;
const send = (reply: RecorderReply) => port.postMessage(reply);
let db: InspectionDatabase;
let telemetry: InspectionTelemetry;
let manifest: InspectionDatasetManifest;
let directory: string;
let policyPath: string;
let retainedBytes = 0;
let writerRejected = 0;
let sourceId: string;
let cachedSourceBytes = 0;
let sourceSizeCheckedAt = 0;
let failed = false;
let budgetExhausted = false;
let timer: ReturnType<typeof setInterval>;
const updateHealth = (dropped: number, rejected: number) => db.updateCoverage({ dropped, rejected: rejected + writerRejected, telemetryDropped: telemetry.dropped });
function checkStorageBudget(additional = 0): void {
  if (budgetExhausted) throw new Error("inspection_storage_budget_exhausted");
  if (Date.now() - sourceSizeCheckedAt > 5000) {
    cachedSourceBytes = inspectionSourceBytes(workerData.root, sourceId);
    sourceSizeCheckedAt = Date.now();
  }
  if (db.size() + retainedBytes + additional > 511 * 1024 * 1024 || cachedSourceBytes + additional > 2047 * 1024 * 1024) {
    budgetExhausted = true;
    db.updateCoverage({ limitations: [...new Set([...db.snapshot().limitations, "storage_budget_exhausted"])] });
    throw new Error("inspection_storage_budget_exhausted");
  }
}
function writeTelemetry(record: Parameters<InspectionDatabase["writeTelemetry"]>[0]): void {
  const bytes = Buffer.byteLength(record.data) * 2 + 8192;
  checkStorageBudget(bytes);
  db.writeTelemetry(record);
  cachedSourceBytes += bytes;
}

try {
  const source = registerInspectionSource(workerData.root, workerData.application, workerData.name);
  sourceId = source.sourceId;
  retireInspectionDatasets(workerData.root, sourceId, { before: new Date(Date.now() - 7 * 86400000).toISOString(), apply: true });
  cachedSourceBytes = inspectionSourceBytes(workerData.root, sourceId);
  if (cachedSourceBytes >= 2047 * 1024 * 1024) {
    retireInspectionDatasets(workerData.root, sourceId, { before: new Date().toISOString(), apply: true });
    cachedSourceBytes = inspectionSourceBytes(workerData.root, sourceId);
    if (cachedSourceBytes >= 2047 * 1024 * 1024) throw new Error("inspection_storage_budget_exhausted");
  }
  sourceSizeCheckedAt = Date.now();
  policyPath = containedInspectionPath(workerData.root, "sources", source.sourceId, "read-policy.json");
  atomicInspectionJson(policyPath, validateInspectionCapturePolicy(workerData.policy));
  manifest = { formatVersion: 1, sourceId: source.sourceId, datasetId: randomUUID(), producerInstanceId: randomUUID(), createdAt: new Date().toISOString(), status: "open" };
  directory = datasetDirectory(workerData.root, source.sourceId, manifest.datasetId);
  db = new InspectionDatabase(directory, manifest);
  atomicInspectionJson(join(directory, "manifest.json"), manifest);
  telemetry = new InspectionTelemetry(source.sourceId, manifest.datasetId);
  timer = setInterval(() => {
    if (failed) return;
    try { checkStorageBudget(8192); db.updateCoverage({}); cachedSourceBytes += 8192; } catch { failed = true; clearInterval(timer); send({ kind: "failed", code: "inspection_storage_unavailable" }); }
  }, 5000);
  timer.unref();
  send({ kind: "ready", source, manifest });
} catch { send({ kind: "failed", code: "inspection_storage_unavailable" }); port.close(); }

let processing = Promise.resolve();
port.on("message", (message: RecorderCommand) => {
  processing = processing.then(async () => {
    if (failed) return;
    try {
      if (message.kind === "batch") {
        for (const offer of message.offers) {
          const bytes = offer.bytes + offer.contents.reduce((sum, content) => sum + content.descriptor.retainedBytes, 0);
          checkStorageBudget(bytes + offer.bytes * 3 + 8192);
          try {
            const committed = db.write(offer.record, offer.contents);
            if (!committed.duplicate) {
              cachedSourceBytes += bytes + offer.bytes * 3 + 8192;
              retainedBytes += offer.contents.reduce((sum, content) => sum + content.descriptor.retainedBytes, 0);
              telemetry.accept(committed.record);
            }
          } catch (error) {
            if (error instanceof Error && error.message === "inspection_record_conflict") {
              writerRejected++;
              const coverage = db.snapshot();
              db.updateCoverage({ limitations: [...new Set([...coverage.limitations, "conflicting_record_identity"])] });
            } else throw error;
          }
        }
        updateHealth(message.dropped, message.rejected);
        await telemetry.flush(writeTelemetry);
        send({ kind: "ack", coverage: db.snapshot() });
      } else {
        if (message.close) await telemetry.close(writeTelemetry);
        else await telemetry.flush(writeTelemetry);
        updateHealth(message.dropped, message.rejected);
        if (message.close) {
          clearInterval(timer);
          db.updateCoverage({ status: "closed" });
          atomicInspectionJson(join(directory, "manifest.json"), { ...manifest, status: "closed" });
        }
        send({ kind: "flushed", id: message.id, coverage: db.snapshot() });
        if (message.close) { db.checkpoint(); db.close(); port.close(); }
      }
    } catch { failed = true; clearInterval(timer); send({ kind: "failed", code: "inspection_storage_unavailable" }); }
  });
});
