import {afterEach, expect, it} from "vitest";
import Database from "better-sqlite3";
import {mkdtempSync, rmSync, readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, relative, resolve} from "node:path";
import {InspectionRecorder} from "../../dist/recording/InspectionRecorder.js";
import {InspectionDatabase} from "../../dist/storage/InspectionDatabase.js";
import {datasetDirectory} from "../sources/index.js";
import {DEFAULT_INSPECTION_CAPTURE_POLICY} from "../content/index.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {for (const dispose of cleanup.splice(0).reverse()) await dispose();});
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "inspection-pipeline-"));
  cleanup.push(async () => {if (!relative(tmpdir(), resolve(root)).startsWith("inspection-pipeline-")) throw new Error("Unsafe cleanup"); rmSync(root, {recursive: true, force: true});});
  const recorder = await InspectionRecorder.create({root, application: "pipeline-test", name: "Test", policy: {...DEFAULT_INSPECTION_CAPTURE_POLICY, agent: true}});
  cleanup.push(() => recorder.flush(true));
  const directory = datasetDirectory(root, recorder.source.sourceId, recorder.manifest.datasetId);
  const ref = recorder.ref("runtime", "run", "run", "run");
  const offer = (id: string, text?: string) => recorder.offer({id, subject: ref, occurredAt: null, payload: {kind: "event", name: "fact", sequence: null, code: null},
    ...(text === undefined ? {} : {contents: [{name: "body", class: "agent", stage: "result", mediaType: "text/plain", value: text}]})});
  return {root, recorder, directory, ref, offer};
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it("persists rejected-input health with no subsequent data batch", async () => {
  const {recorder, directory} = await setup();
  expect(recorder.offer({} as never)).toBe(false);
  await sleep(200);
  const db = new InspectionDatabase(directory);
  try {expect(db.snapshot().recording?.ingress).toMatchObject({accepted: 0, rejected: 1,
    issues: [{reason: "invalid_input", firstSequence: null, samples: [{subject: null}]}]});}
  finally {db.close();}
});

it("keeps a nonclosing flush barrier fixed while later offers continue", async () => {
  const {recorder, offer} = await setup(); offer("before");
  const flush = recorder.flush();
  for (let index = 0; index < 150; index++) offer(`later-${index}`);
  const result = await flush;
  expect(result.barrier.accepted).toBe(1);
  expect(result.native).toBe("settled");
  expect(result.projection).toBe("settled");
  expect(recorder.health().available).toBe(true);
  expect((await recorder.flush()).native).toBe("settled");
});

it("reports exact count saturation independently of projection omissions", async () => {
  const {recorder, offer, directory} = await setup();
  for (let index = 0; index < 4100; index++) offer(`record-${index}`);
  expect(recorder.health().dropped).toBe(4);
  let result = await recorder.flush();
  for (let retry = 0; result.native === "pending" && retry < 4; retry++) result = await recorder.flush();
  expect(result.native).toBe("settled");
  const db = new InspectionDatabase(directory);
  try {
    expect(db.snapshot().recording?.ingress).toMatchObject({accepted: 4096, dropped: 4,
      issues: [{reason: "record_capacity", count: 4, firstSequence: 4097, lastSequence: 4100}]});
    expect(db.snapshot().captured).toBe(4096);
    expect(db.snapshot().telemetryDropped).toBe(0);
  } finally {db.close();}
});

it("distinguishes content-byte saturation from count saturation", async () => {
  const {recorder, offer, directory} = await setup();
  const body = "x".repeat(1024 * 1024);
  for (let index = 0; index < 34; index++) offer(`large-${index}`, body);
  expect(recorder.health().dropped).toBe(2);
  await recorder.flush();
  const db = new InspectionDatabase(directory);
  try {expect(db.snapshot().recording?.ingress.issues).toMatchObject([{reason: "content_capacity", count: 2}]);}
  finally {db.close();}
});

it("distinguishes structure-byte saturation from count and content limits", async () => {
  const {recorder, directory, ref} = await setup();
  let accepted = 0;
  for (let index = 0; index < 2000; index++) {
    if (recorder.offer({id: `structure-${index}`, subject: ref, occurredAt: null,
      payload: {kind: "event", name: "fact", sequence: index, code: null},
      links: Array.from({length: 24}, (_, link) => ({kind: "binding" as const, from: ref,
        to: recorder.ref("runtime", "event", `${index}-${link}-${"x".repeat(64)}`, "run"),
        condition: null, operation: null, sourceLocation: null, targetLocation: null}))})) accepted++;
  }
  expect(accepted).toBeGreaterThan(0);
  expect(accepted).toBeLessThan(2000);
  let result = await recorder.flush();
  for (let retry = 0; result.native === "pending" && retry < 4; retry++) result = await recorder.flush();
  expect(result.native).toBe("settled");
  const db = new InspectionDatabase(directory);
  try {
    expect(db.snapshot().recording?.ingress.issues).toMatchObject([{reason: "structure_capacity", count: 2000 - accepted}]);
    expect(db.snapshot().captured).toBe(accepted);
  } finally {db.close();}
});

it("retains a representative 25000-record burst with repeated bounded bodies and independent telemetry progress", async () => {
  const {recorder, directory} = await setup();
  const started = performance.now();
  let bodyBytes = 0;
  for (let batch = 0; batch < 250; batch++) {
    for (let index = batch * 100; index < (batch + 1) * 100; index++) {
      const subject = recorder.ref(index % 2 ? "runtime" : "model-interaction", "event", `fact-${index}`, `run-${index % 8}`);
      const text = index % 3 === 0 ? `${index % 18000}:` + "x".repeat(index % 9 === 0 ? 42 * 1024 : 4 * 1024) : null;
      bodyBytes += text?.length ?? 0;
      const accepted = recorder.offer({id: `burst-${index}`, subject, occurredAt: new Date().toISOString(),
        payload: {kind: "event", name: "owner_fact", code: null, sequence: index},
        contents: text === null ? [] : [{name: "body", stage: "received", class: "agent", mediaType: "text/plain", value: text}]});
      expect(accepted, accepted ? undefined : JSON.stringify({index, health: recorder.health()})).toBe(true);
    }
    await sleep(100);
  }
  let result = await recorder.flush();
  for (let retry = 0; (result.native === "pending" || result.projection === "pending") && retry < 10; retry++) result = await recorder.flush();
  expect(result).toMatchObject({native: "settled", projection: "settled", unpersisted: 0, unconfirmed: 0});
  expect(recorder.health()).toMatchObject({available: true, dropped: 0, rejected: 0, queued: 0});
  const db = new InspectionDatabase(directory);
  const raw = new Database(join(directory, "inspection.sqlite"), {readonly: true});
  try {
    const coverage = db.snapshot();
    expect(coverage.captured).toBe(25000);
    expect(coverage.telemetryDropped).toBe(0);
    expect(coverage.recording?.timings?.projectionConversion.count).toBeGreaterThan(0);
    expect(coverage.recording?.timings?.projectionWrite.count).toBeGreaterThan(0);
    expect(coverage.recording!.projection.sliceMaxMs).toBeGreaterThanOrEqual(coverage.recording!.timings!.projectionWrite.maxMs);
    expect(raw.prepare("SELECT COUNT(*) n FROM contents WHERE body_id IS NULL").get()).toEqual({n: 0});
    expect(raw.prepare("SELECT COUNT(*) n FROM batch_receipts").get()).toEqual({n: 250});
    expect(readdirSync(directory).some(name => name === "content" || name === "staging")).toBe(false);
    console.log("Inspection representative burst", {records: coverage.captured, offeredBodyBytes: bodyBytes,
      elapsedMs: Math.round(performance.now() - started), databaseBytes: db.size(), progress: coverage.recording});
  } finally {raw.close(); db.close();}
}, 60_000);
