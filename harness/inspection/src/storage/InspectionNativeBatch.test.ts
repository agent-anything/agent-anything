import {afterEach, expect, it, vi} from "vitest";
import Database from "better-sqlite3";
import {createHash} from "node:crypto";
import {mkdtempSync, readdirSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, relative, resolve} from "node:path";
import {InspectionDatabase} from "./InspectionDatabase.js";
import {INSPECTION_FORMAT_VERSION, initialInspectionProgress, type InspectionRecord} from "../records/index.js";
import type {InspectionOffer} from "../recording/InspectionRecorderProtocol.js";

const cleanup: (() => void)[] = [];
afterEach(() => {for (const dispose of cleanup.splice(0).reverse()) dispose();});
function setup() {
  const path = mkdtempSync(join(tmpdir(), "inspection-native-"));
  cleanup.push(() => {if (!relative(tmpdir(), resolve(path)).startsWith("inspection-native-")) throw new Error("Unsafe cleanup"); rmSync(path, {recursive: true, force: true});});
  const manifest = {formatVersion: INSPECTION_FORMAT_VERSION, sourceId: "source", datasetId: "dataset", producerInstanceId: "producer", createdAt: new Date().toISOString(), status: "open" as const};
  const db = new InspectionDatabase(path, manifest); cleanup.push(() => db.close());
  const raw = new Database(join(path, "inspection.sqlite")); cleanup.push(() => raw.close());
  return {db, raw, path};
}
function offer(id: string, sequence = 1, text = "retained"): InspectionOffer {
  const descriptor = {id: `${id}-body`, name: "body", class: "agent" as const, stage: "source", mediaType: "text/plain", availability: "present" as const,
    retainedBytes: Buffer.byteLength(text), originalBytes: Buffer.byteLength(text), digest: createHash("sha256").update(text).digest("hex"), redacted: false, truncated: false};
  const record: InspectionRecord = {id, subject: {sourceId: "source", datasetId: "dataset", owner: "test", kind: "event", id, runId: "run", revision: "1"},
    occurredAt: null, capturedAt: "2026-10-13T00:00:00Z", ownerSequence: null, captureSequence: sequence, commitSequence: 0, policyRevision: "1",
    payload: {kind: "event", name: "fact", code: null, sequence: null}, links: [], contents: [descriptor]};
  return {record, contents: [{descriptor, text}], bytes: Buffer.byteLength(JSON.stringify(record))};
}
const digest = (offers: readonly InspectionOffer[]) => createHash("sha256").update(JSON.stringify(offers)).digest("hex");
const health = (accepted: number) => ({...initialInspectionProgress().ingress, accepted, revision: accepted});

it("commits native bodies, descriptors and receipts atomically without projecting telemetry", () => {
  const {db, raw, path} = setup();
  const offers = [offer("first"), offer("second", 2)];
  const receipt = db.writeNativeBatch("batch", digest(offers), offers, health(2));
  expect(receipt).toMatchObject({persisted: 2, duplicates: 0, rejected: 0});
  expect(db.receipt("batch")).toEqual(receipt);
  expect(db.snapshot().recording).toMatchObject({native: {persisted: 2, target: 2}, projection: {cursor: 0}});
  expect(raw.prepare("SELECT COUNT(*) n FROM bodies").get()).toEqual({n: 1});
  expect(raw.prepare("SELECT COUNT(*) n FROM contents").get()).toEqual({n: 2});
  expect(readdirSync(path).some(name => name === "content" || name === "staging")).toBe(false);
  expect(db.readContent("first-body", receipt.watermark, 0, 256)?.text).toBe("retained");
  expect(db.readContent("second-body", receipt.watermark, 0, 256)?.text).toBe("retained");
});

it("reconciles exact batch replay and distinguishes identity conflict from duplicate offers", () => {
  const {db} = setup(); const first = offer("first"); const offers = [first];
  const receipt = db.writeNativeBatch("batch", digest(offers), offers, health(1));
  expect(db.writeNativeBatch("batch", digest(offers), offers, health(1))).toEqual(receipt);
  expect(db.snapshot().captured).toBe(1);
  const changed = [offer("changed")];
  expect(() => db.writeNativeBatch("batch", digest(changed), changed, health(1))).toThrow("inspection_batch_conflict");
  const repeated = [{...first, record: {...first.record, captureSequence: 2}},
    {...first, record: {...first.record, captureSequence: 3, payload: {kind: "event" as const, name: "changed", code: null, sequence: null}}}];
  expect(db.writeNativeBatch("batch2", digest(repeated), repeated, health(3))).toMatchObject({persisted: 0, duplicates: 1, rejected: 1});
  expect(db.snapshot().recording?.native).toMatchObject({persisted: 1, duplicates: 1, rejected: 1});
});

it("rolls back bodies, records and the receipt when a later body is invalid", () => {
  const {db, raw} = setup();
  const first = offer("first"); const second = offer("second", 2, "other");
  const offers = [first, {...second, contents: [{...second.contents[0]!, text: "corrupt"}]}];
  expect(() => db.writeNativeBatch("batch", digest(offers), offers, health(2))).toThrow("inspection_content_integrity_failed");
  expect(db.receipt("batch")).toBeNull(); expect(db.snapshot().captured).toBe(0);
  expect(raw.prepare("SELECT COUNT(*) n FROM bodies").get()).toEqual({n: 0});
  expect(raw.prepare("SELECT COUNT(*) n FROM records").get()).toEqual({n: 0});
});

it("commits projection output and cursor together, with no native-record recursion", () => {
  const {db, raw} = setup(); const offers = [offer("first")];
  const receipt = db.writeNativeBatch("batch", digest(offers), offers, health(1));
  const output = {id: "log", kind: "log" as const, recordId: "first", subjectKey: "subject", traceId: null, spanId: null, data: "{}"};
  raw.exec("CREATE UNIQUE INDEX injected_projection_failure ON telemetry_logs(value)");
  expect(() => db.writeProjection([output, {...output, id: "other"}], {...db.snapshot().recording!.projection, cursor: receipt.nativeWatermark}, 0)).toThrow();
  expect(db.snapshot().recording?.projection.cursor).toBe(0);
  expect(db.telemetry(db.snapshot().watermark, null)).toEqual([]);
  db.writeProjection([output], {...db.snapshot().recording!.projection, cursor: receipt.nativeWatermark}, 0);
  expect(db.records({watermark: db.snapshot().watermark})).toHaveLength(1);
  expect(db.telemetry(db.snapshot().watermark, null)).toHaveLength(1);
});

it("skips unchanged health while preserving newly measured costs at the same health revision", () => {
  const {db, raw} = setup(), offers = [offer("first")];
  db.writeNativeBatch("batch", digest(offers), offers, health(1));
  db.updateIngress(health(1));
  const before = db.snapshot();
  db.updateIngress(health(1));
  expect(db.snapshot()).toEqual(before);
  db.recordTiming("projectionSlice", 37);
  db.updateIngress(health(1));
  expect(db.snapshot().recording?.projection.sliceMaxMs).toBe(37);
  expect(db.snapshot().recording?.timings?.projectionSlice).toEqual({count: 1, totalMs: 37, maxMs: 37});
  expect(db.snapshot().watermark).toBe(before.watermark + 1);
  db.updateIngress(health(1));
  expect(db.snapshot().watermark).toBe(before.watermark + 1);
  expect(raw.prepare("SELECT COUNT(*) n FROM records").get()).toEqual({n: 1});
});

it("measures projection through the completed write, without a recursive metrics transaction", () => {
  const {db} = setup();
  const original = db.writeBatch.bind(db);
  const write = vi.spyOn(db, "writeBatch").mockImplementation(work => {
    const result = original(work);
    // Simulate expensive transaction completion, after projection conversion.
    const until = performance.now() + 20;
    while (performance.now() < until) { /* Deliberate synchronous test cost. */ }
    return result;
  });
  try {
    db.writeProjection([], db.snapshot().recording!.projection, 0);
    const before = db.snapshot().watermark;
    db.updateIngress(health(0));
    expect(db.snapshot().recording?.timings?.projectionWrite.maxMs).toBeGreaterThanOrEqual(20);
    expect(write).toHaveBeenCalledTimes(1);
    expect(db.snapshot().watermark).toBe(before + 1);
    db.updateIngress(health(0));
    expect(db.snapshot().watermark).toBe(before + 1);
  } finally {write.mockRestore();}
});
