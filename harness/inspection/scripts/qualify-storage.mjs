import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { InspectionDatabase } from "../dist/storage/index.js";
import { datasetDirectory } from "../dist/sources/index.js";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "agent-inspection-storage-"));
const sourceId = randomUUID();
const datasetId = randomUUID();
const manifest = { formatVersion: 1, sourceId, datasetId, producerInstanceId: randomUUID(), createdAt: new Date().toISOString(), status: "open" };
const childCode = `import { parentPort, workerData } from 'node:worker_threads'; import { InspectionDatabase } from ${JSON.stringify(new URL("../dist/storage/index.js", import.meta.url).href)}; const db=new InspectionDatabase(workerData); parentPort.postMessage({engine:db.engineVersion(),snapshot:db.snapshot()});db.close();`;
const readerCode = `const {Worker}=require('node:worker_threads'); const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(${JSON.stringify(childCode)})),{workerData:${JSON.stringify(directory)}});worker.on('message',value=>process.stdout.write(JSON.stringify({runtime:process.versions,result:value})));worker.on('error',error=>{console.error(error);process.exitCode=1});`;
let database;
try {
  database = new InspectionDatabase(directory, manifest);
  const version = database.engineVersion();
  assert.match(version, /^3\.(5[3-9]|[6-9]\d)\./);
  database.write({ id: "record-1", subject: { sourceId, datasetId, owner: "runtime", kind: "run", id: "run-1", runId: "run-1", revision: null }, occurredAt: manifest.createdAt, capturedAt: manifest.createdAt, captureSequence: 1, commitSequence: 0, ownerSequence: 1, policyRevision: "test", payload: { kind: "snapshot", status: "running", revision: 1, agentId: "agent-1", parentRunId: null, taskId: "task-1" }, links: [], contents: [] }, []);
  const electron = require(resolve(root, "products/helarc/desktop/node_modules/electron"));
  for (const executable of [process.execPath, electron]) {
    const result = spawnSync(executable, ["-e", readerCode], { encoding: "utf8", timeout: 15000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const output = JSON.parse(result.stdout);
    assert.equal(output.result.engine, version);
    assert.equal(output.result.snapshot.captured, database.snapshot().captured);
    console.log(JSON.stringify({ node: output.runtime.node, electron: output.runtime.electron ?? null, napi: output.runtime.napi, sqlite: output.result.engine, independentWorkerRead: true }));
    const captureRoot = join(directory, output.runtime.electron ? "electron-producer" : "node-producer");
    const writerCode = `const {InspectionRecorder}=await import(${JSON.stringify(new URL("../dist/recording/index.js", import.meta.url).href)}); const recorder=await InspectionRecorder.create({root:${JSON.stringify(captureRoot)},application:'qualification',name:'Qualification'});recorder.offer({subject:recorder.ref('runtime','run','crashed-run','crashed-run'),occurredAt:null,payload:{kind:'event',name:'committed-before-exit',sequence:null,code:null}});await recorder.flush();process.stdout.write(JSON.stringify({sourceId:recorder.source.sourceId,datasetId:recorder.manifest.datasetId}));process.exit(73);`;
    const producer = spawnSync(executable, ["-e", `(async()=>{${writerCode}})().catch(error=>{console.error(error);process.exitCode=1});`], { encoding: "utf8", timeout: 15000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    assert.equal(producer.status, 73, producer.stderr || String(producer.error));
    const produced = JSON.parse(producer.stdout);
    const recovered = new InspectionDatabase(datasetDirectory(captureRoot, produced.sourceId, produced.datasetId));
    assert.equal(recovered.snapshot().captured, 1);
    assert.equal(recovered.snapshot().status, "open");
    assert.equal(recovered.records({ watermark: recovered.snapshot().watermark })[0].payload.name, "committed-before-exit");
    recovered.close();
    console.log(JSON.stringify({ producer: output.runtime.electron ? "electron" : "node", recorderWorker: true, abruptExitRecovery: true }));
    const record = database.records({ watermark: database.snapshot().watermark })[0];
    const readerProgram = `(async()=>{const {InspectionDatabase}=await import(${JSON.stringify(new URL("../dist/storage/index.js", import.meta.url).href)});const db=new InspectionDatabase(${JSON.stringify(directory)});db.db.exec('BEGIN');const before=db.snapshot();process.send({ready:true});process.on('message',()=>{const during=db.snapshot();db.db.exec('COMMIT');db.close();process.send({stable:before.watermark===during.watermark});process.disconnect();});})().catch(error=>{console.error(error);process.exit(1)});`;
    const heldReader = spawn(executable, ["-e", readerProgram], { stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    const killTimer = setTimeout(() => heldReader.kill(), 15000);
    try {
      await new Promise((resolve, reject) => { heldReader.once("message", resolve); heldReader.once("error", reject); heldReader.once("exit", (code) => { if (code !== 0) reject(new Error("qualification reader failed")); }); });
      database.write({ ...record, id: randomUUID(), captureSequence: record.captureSequence + 1 }, []);
      database.checkpoint();
      const released = new Promise((resolve, reject) => { heldReader.once("message", resolve); heldReader.once("error", reject); });
      const exited = new Promise((resolve) => heldReader.once("exit", resolve));
      heldReader.send("release");
      assert.equal((await released).stable, true);
      assert.equal(await exited, 0);
      console.log(JSON.stringify({ producer: output.runtime.electron ? "electron" : "node", heldWalReader: true, concurrentWriteAndPassiveCheckpoint: true }));
    } finally { clearTimeout(killTimer); if (heldReader.exitCode === null) heldReader.kill(); }

    const crashDirectory = join(directory, output.runtime.electron ? "electron-transaction-crash" : "node-transaction-crash");
    const descriptor = { id: "orphan-content", name: "crash proof", class: "agent", stage: "published", mediaType: "text/plain", availability: "present", retainedBytes: 5, originalBytes: 5, digest: createHash("sha256").update("proof").digest("hex"), redacted: false, truncated: false };
    const crashProgram = `(async()=>{const {InspectionDatabase}=await import(${JSON.stringify(new URL("../dist/storage/index.js", import.meta.url).href)});const db=new InspectionDatabase(${JSON.stringify(crashDirectory)},${JSON.stringify(manifest)});db.write(${JSON.stringify(record)},[]);db.db.transaction=fn=>()=>{db.db.exec('BEGIN IMMEDIATE');fn();process.exit(77);};db.write(${JSON.stringify({ ...record, id: "never-committed", contents: [descriptor] })},${JSON.stringify([{ descriptor, text: "proof" }])});})().catch(error=>{console.error(error);process.exit(1)});`;
    const crashed = spawnSync(executable, ["-e", crashProgram], { encoding: "utf8", timeout: 15000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    assert.equal(crashed.status, 77, crashed.stderr || String(crashed.error));
    assert.equal(existsSync(join(crashDirectory, "content", descriptor.id)), true);
    const reopened = new InspectionDatabase(crashDirectory);
    assert.equal(reopened.snapshot().captured, 1);
    assert.equal(reopened.record("never-committed", reopened.snapshot().watermark), null);
    assert.equal(reopened.content(descriptor.id, reopened.snapshot().watermark), null);
    reopened.close();
    console.log(JSON.stringify({ producer: output.runtime.electron ? "electron" : "node", crashAfterContentBeforeCommit: true, orphanNotReadable: true }));
  }
  database.checkpoint();
  database.close();
  database = undefined;
  const read = new InspectionDatabase(directory);
  assert.equal(read.records({ watermark: 1 })[0].payload.status, "running");
  read.close();
  console.log("SQLite Node/Electron worker, concurrent WAL reader, checkpoint and offline history checks passed.");
} finally {
  database?.close();
  const relativePath = relative(tmpdir(), directory);
  if (!isAbsolute(relativePath) && !relativePath.startsWith("..") && directory.startsWith(join(tmpdir(), "agent-inspection-storage-"))) rmSync(directory, { recursive: true, force: true });
}
