import {EventEmitter} from "node:events";
import {afterEach, expect, it, vi} from "vitest";
import {INSPECTION_FORMAT_VERSION, initialInspectionProgress, type InspectionCoverage, type InspectionBatchReceipt} from "../records/index.js";
import type {RecorderCommand} from "./InspectionRecorderProtocol.js";
import {InspectionRecorder} from "./InspectionRecorder.js";

const fake = vi.hoisted(() => ({create: null as null | (() => unknown)}));
vi.mock("node:worker_threads", () => ({Worker: class {constructor() {return fake.create!();}}}));
const recorders: InspectionRecorder[] = [];
afterEach(async () => {
  for (const recorder of recorders.splice(0)) {
    const closing = recorder.flush(true); await vi.advanceTimersByTimeAsync(2500); await closing;
  }
  vi.useRealTimers();
});
class FakeWorker extends EventEmitter {
  readonly commands: RecorderCommand[] = [];
  postMessage(message: RecorderCommand) {this.commands.push(message);}
  unref() {}
  async terminate() {this.emit("exit", 0); return 0;}
}
async function setup() {
  vi.useFakeTimers();
  const worker = new FakeWorker();
  fake.create = () => worker;
  const pending = InspectionRecorder.create({application: "test", name: "Test", root: "Z:/missing-inspection-test-root"});
  worker.emit("message", {kind: "ready", source: {sourceId: "source", application: "test", name: "Test", formatVersion: INSPECTION_FORMAT_VERSION},
    manifest: {sourceId: "source", datasetId: "dataset", formatVersion: INSPECTION_FORMAT_VERSION, producerInstanceId: "producer", createdAt: "2026-10-13T00:00:00Z", status: "open"}});
  const recorder = await pending; recorders.push(recorder);
  const coverage: InspectionCoverage = {status: "open", watermark: 1, captured: 1, dropped: 0, rejected: 0, telemetryDropped: 0,
    heartbeat: "2026-10-13T00:00:00Z", limitations: [], recording: initialInspectionProgress()};
  const offer = (id: string) => recorder.offer({id, subject: recorder.ref("test", "event", id), occurredAt: null,
    payload: {kind: "event", name: id, code: null, sequence: null}});
  const receipt = (message: Extract<RecorderCommand, {kind: "batch"}>): InspectionBatchReceipt => ({id: message.id, digest: message.digest,
    firstSequence: message.offers[0]!.record.captureSequence, lastSequence: message.offers.at(-1)!.record.captureSequence,
    persisted: message.offers.length, duplicates: 0, rejected: 0, watermark: 1, nativeWatermark: 1, precommitMs: 0, rejectedOffers: []});
  return {worker, recorder, offer, receipt, coverage};
}
it("does not label an unacknowledged committed batch lost and resumes dispatch after receipt lookup", async () => {
  const t = await setup(); t.offer("one"); await vi.advanceTimersByTimeAsync(60); t.offer("two");
  const first = t.worker.commands.find((command): command is Extract<RecorderCommand, {kind: "batch"}> => command.kind === "batch")!;
  const pending = t.recorder.flush(); await vi.advanceTimersByTimeAsync(2100);
  expect(await pending).toMatchObject({native: "pending", code: "inspection_flush_timeout"});
  expect(t.worker.commands).toContainEqual({kind: "receipt", id: first.id});
  expect(t.recorder.health()).toMatchObject({available: true, dropped: 0, queued: 2});
  t.worker.emit("message", {kind: "receipt", id: first.id, receipt: t.receipt(first), coverage: t.coverage});
  const batches = t.worker.commands.filter(command => command.kind === "batch");
  expect(batches).toHaveLength(2);
  expect(batches[1]?.offers[0]?.record.id).toBe("two");
});
it("releases native ingress credit without waiting for projection or flush", async () => {
  const t = await setup(); t.offer("one"); await vi.advanceTimersByTimeAsync(60);
  const batch = t.worker.commands.find((command): command is Extract<RecorderCommand, {kind: "batch"}> => command.kind === "batch")!;
  t.worker.emit("message", {kind: "ack", receipt: t.receipt(batch), coverage: t.coverage});
  expect(t.recorder.health().queued).toBe(0);
  expect(t.recorder.health().coverage?.recording?.projection.cursor).toBe(0);
  expect(t.worker.commands.some(command => command.kind === "flush")).toBe(false);
});
it("rechecks a scheduled health send after a matching native receipt acknowledged that snapshot", async () => {
  const t = await setup();
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  try {
    t.offer("one");
    await vi.advanceTimersByTimeAsync(60);
    const batch = t.worker.commands.find((command): command is Extract<RecorderCommand, {kind: "batch"}> => command.kind === "batch")!;
    expect(batch).toBeDefined();
    t.worker.emit("message", {kind: "ack", receipt: t.receipt(batch),
      coverage: {...t.coverage, recording: {...t.coverage.recording!, ingress: batch.health}}});
    await vi.advanceTimersByTimeAsync(60);
    expect(t.worker.commands.filter(command => command.kind === "health")).toHaveLength(0);
    expect(t.recorder.health().queued).toBe(0);
  } finally {clock.mockRestore();}
});
it("separates an unknown in-flight tail from never-sent queued records on Worker failure", async () => {
  const t = await setup(); t.offer("sent"); await vi.advanceTimersByTimeAsync(60); t.offer("unsent");
  t.worker.emit("error", new Error("worker failure"));
  expect(t.recorder.health()).toMatchObject({available: false, dropped: 0, unpersisted: 1, unconfirmed: 1});
});
it("rejects extra flush requests without failing healthy recording", async () => {
  const t = await setup();
  const pending = t.recorder.flush();
  const request = t.worker.commands.find((command): command is Extract<RecorderCommand, {kind: "flush"}> => command.kind === "flush")!;
  t.worker.emit("message", {kind: "flush_rejected", id: request.id, code: "inspection_flush_capacity"});
  expect(await pending).toMatchObject({native: "settled", projection: "pending", code: "inspection_flush_capacity"});
  expect(t.recorder.health().available).toBe(true);
  expect(t.offer("after-rejection")).toBe(true);
});
