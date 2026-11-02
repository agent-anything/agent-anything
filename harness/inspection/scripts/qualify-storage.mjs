import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { InspectionDatabase } from "../dist/storage/index.js";
import { INSPECTION_FORMAT_VERSION,inspectionEvidenceKey } from "../dist/records/index.js";
import { datasetDirectory } from "../dist/sources/index.js";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "agent-inspection-storage-"));
const sourceId = randomUUID();
const datasetId = randomUUID();
const manifest = { formatVersion: INSPECTION_FORMAT_VERSION, sourceId, datasetId, producerInstanceId: randomUUID(), createdAt: new Date().toISOString(), status: "open" };
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
    const processOrigin={owner:"original-owner",id:"original-fact",runId:"crashed-run",revision:"1"};
    const writerCode = `const {InspectionRecorder}=await import(${JSON.stringify(new URL("../dist/recording/index.js", import.meta.url).href)}); const recorder=await InspectionRecorder.create({root:${JSON.stringify(captureRoot)},application:'qualification',name:'Qualification'});const subject=recorder.ref('runtime','run','crashed-run','crashed-run');recorder.offer({subject,occurredAt:null,payload:{kind:'event',name:'committed-before-exit',sequence:null,code:null}});
      for(const digest of ['original-basis','original-basis','conflicting-basis'])recorder.offer({subject,occurredAt:null,payload:{kind:'process_evidence',version:'1',origin:${JSON.stringify(processOrigin)},digest,category:'decision',subject,name:'accepted',status:'accepted',purpose:'task',recipient:null,relationCount:1}});
      const flush=await recorder.flush();if(flush.native!=='settled')throw new Error('native_not_settled');process.stdout.write(JSON.stringify({sourceId:recorder.source.sourceId,datasetId:recorder.manifest.datasetId}));process.exit(73);`;
    const producer = spawnSync(executable, ["-e", `(async()=>{${writerCode}})().catch(error=>{console.error(error);process.exitCode=1});`], { encoding: "utf8", timeout: 15000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    assert.equal(producer.status, 73, producer.stderr || String(producer.error));
    const produced = JSON.parse(producer.stdout);
    const recovered = new InspectionDatabase(datasetDirectory(captureRoot, produced.sourceId, produced.datasetId));
    assert.equal(recovered.snapshot().captured, 4);
    assert.equal(recovered.snapshot().status, "open");
    assert.equal(recovered.records({ watermark: recovered.snapshot().watermark })[0].payload.name, "committed-before-exit");
    const fixedWatermark=recovered.snapshot().watermark,originalRecords=recovered.records({watermark:fixedWatermark});
    assert.equal(recovered.process.evidence({watermark:fixedWatermark}).length,3);
    assert.equal(recovered.process.variants({watermark:fixedWatermark,evidenceKey:inspectionEvidenceKey(processOrigin)}).length,2);
    assert(recovered.snapshot().processProjection.cursor>=recovered.snapshot().recording.native.target);
    recovered.close();
    console.log(JSON.stringify({ producer: output.runtime.electron ? "electron" : "node", recorderWorker: true, abruptExitRecovery: true }));
    const processDirectory=datasetDirectory(captureRoot,produced.sourceId,produced.datasetId);
    for(const step of ["interrupt","resume"]){
      const program=`import {parentPort,workerData} from 'node:worker_threads';import {InspectionDatabase} from ${JSON.stringify(new URL("../dist/storage/index.js",import.meta.url).href)};
        const db=new InspectionDatabase(workerData.directory,undefined,{writable:true});
        if(workerData.step==='interrupt'){db.resetProcessProjection();db.rebuildProcessProjection(workerData.watermark,1);}
        else{if(db.process.progress().status!=='rebuilding')throw new Error('rebuild_state_lost');while(db.process.progress().status==='rebuilding')db.rebuildProcessProjection(workerData.watermark,1);}
        parentPort.postMessage({progress:db.process.progress(),records:db.records({watermark:workerData.watermark}),evidence:db.process.evidence({watermark:workerData.watermark})});db.close();`;
      const runner=`const {Worker}=require('node:worker_threads');const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(${JSON.stringify(program)})),{workerData:${JSON.stringify({directory:processDirectory,step,watermark:fixedWatermark})}});worker.on('message',value=>process.stdout.write(JSON.stringify(value)));worker.on('error',error=>{console.error(error);process.exitCode=1});`;
      const rebuilt=spawnSync(executable,["-e",runner],{encoding:"utf8",timeout:15000,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:"1"}});
      assert.equal(rebuilt.status,0,rebuilt.stderr||String(rebuilt.error));const state=JSON.parse(rebuilt.stdout);
      assert.deepEqual(state.records,originalRecords);assert.equal(state.progress.status,step==="interrupt"?"rebuilding":"live");
      if(step==="resume")assert.equal(state.evidence.length,3);
    }
    console.log(JSON.stringify({producer:output.runtime.electron?"electron":"node",typedOriginalVariants:2,observations:3,partialProjectionRestart:true,originalRecordsUnchanged:true}));
    const processQueryProgram=`
      const assert=(await import('node:assert/strict')).default;
      const {InspectionRecorder}=await import(${JSON.stringify(new URL("../dist/recording/index.js",import.meta.url).href)});
      const {InspectionQueryService}=await import(${JSON.stringify(new URL("../dist/query/index.js",import.meta.url).href)});
      const root=${JSON.stringify(captureRoot)},prior=${JSON.stringify(produced)},origin=${JSON.stringify(processOrigin)};
      const r=await InspectionRecorder.create({root,application:'qualification',name:'Qualification'}),q=new InspectionQueryService(root);
      try{
        const here={sourceId:r.source.sourceId,datasetId:r.manifest.datasetId},subject=r.ref('runtime','run','crashed-run','crashed-run');
        const add=id=>r.offer({id,subject,occurredAt:null,payload:{kind:'process_evidence',version:'1',origin,digest:'original-basis',category:'decision',subject,name:'accepted',status:'accepted',purpose:'task',recipient:null,relationCount:1}});
        add('replayed');r.offer({id:'explicit-recovery',subject,occurredAt:null,payload:{kind:'recording_link',stage:'recovery_prepared',target:{...prior,runId:'crashed-run'},limitation:null}});
        assert.equal((await r.flush()).native,'settled');
        const manifest=(await q.query({kind:'open_process_scope',recordings:[{...here,via:null},{...prior,via:{...here,recordId:'explicit-recovery',linkId:null}}]})).process.manifest;
        const query={kind:'list_context_process',manifest,section:'facts',runId:'crashed-run',limit:1};
        const first=(await q.query(query)).process;assert.equal(first.entries.length,1);
        add('after-frozen-boundary');assert.equal((await r.flush()).native,'settled');
        const seen=[first.entries[0].record];let after=first.page.next;
        while(after){const page=(await q.query({...query,after})).process;seen.push(...page.entries.map(e=>e.record));after=page.page.next;}
        assert.equal(seen.length,4);assert(!seen.some(r=>r.id==='after-frozen-boundary'));
        const variants=(await q.query({kind:'get_context_decision',manifest,section:'variants',evidence:{origin,digest:'original-basis'}})).process.variants;
        assert.equal(variants.length,3);assert.equal(new Set(variants.map(v=>v.digest)).size,2);
        const abort=new AbortController(),pending=q.query(query,abort.signal);abort.abort();await assert.rejects(pending,/inspection_query_cancelled/);
        assert.equal((await q.query(query)).process.entries.length,1);
        process.stdout.write(JSON.stringify({multiRecordingQueryWorker:true,frozenPages:4,variants:2,lateWriteExcluded:true,queryCancellationIsolated:true,unknownTailPreserved:first.recordings.some(r=>r.coverage.status==='open')}));
      }finally{await q.close();await r.flush(true);}`;
    const queried=spawnSync(executable,["-e",`(async()=>{${processQueryProgram}})().catch(error=>{console.error(error);process.exitCode=1});`],{encoding:"utf8",timeout:15000,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:"1"}});
    assert.equal(queried.status,0,queried.stderr||String(queried.error));
    console.log(JSON.stringify({producer:output.runtime.electron?"electron":"node",...JSON.parse(queried.stdout)}));
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
    assert.equal(existsSync(join(crashDirectory, "content")), false);
    const reopened = new InspectionDatabase(crashDirectory);
    assert.equal(reopened.snapshot().captured, 1);
    assert.equal(reopened.snapshot().processProjection.cursor,1);
    assert.equal(reopened.record("never-committed", reopened.snapshot().watermark), null);
    assert.equal(reopened.content(descriptor.id, reopened.snapshot().watermark), null);
    assert.deepEqual(reopened.db.prepare("SELECT COUNT(*) AS count FROM bodies").get(), {count: 0});
    reopened.close();
    console.log(JSON.stringify({ producer: output.runtime.electron ? "electron" : "node", crashAfterBodyBeforeCommit: true, bodyAndDescriptorRolledBack: true }));
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
