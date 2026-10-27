const {app, safeStorage} = require("electron");
const assert = require("node:assert/strict");
const {join} = require("node:path");
const {pathToFileURL} = require("node:url");
const {mkdir, readFile, writeFile} = require("node:fs/promises");
const [directory, scenario, stage] = process.argv.slice(2);
app.setPath("userData", join(directory, "electron-user-data"));
app.disableHardwareAcceleration();
globalThis.fetch = async () => {throw new Error("No model or network is used by this verification");};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {if (Date.now() > deadline) throw new Error("Process boundary was not reached"); await delay(10);}
}
let store, inspection, manager;
const runId = "run", executionId = "command";
async function main() {
  await app.whenReady(); assert(safeStorage.isEncryptionAvailable());
  const load = path => import(pathToFileURL(join(__dirname, "../../dist/main", path)).href);
  const {HelarcExecutionStore} = await load("execution-storage/HelarcExecutionStore.js");
  const {ElectronSafeStorageCredentialCipher} = await load("provider/ElectronSafeStorageCredentialCipher.js");
  const {HelarcInspection} = await load("inspection/HelarcInspection.js");
  const {RunProcessManager} = await import("@agent-anything/helarc-local-environment/command");
  const {WindowsJobProcessBackend, resolveWindowsProcessHelper} = await import(pathToFileURL(join(__dirname,
    "../../../local-environment/dist/command/WindowsJobProcessBackend.js")).href);
  inspection = await HelarcInspection.create(join(directory, "inspection-settings.json"), join(directory, "inspection"));
  assert(inspection.snapshot().health.available);
  store = await HelarcExecutionStore.open(join(directory, "execution"), undefined, undefined, undefined, undefined, new ElectronSafeStorageCredentialCipher(), inspection.contextMaterialObserver);
  const realBackend = new WindowsJobProcessBackend(await resolveWindowsProcessHelper());
  let launches = 0, lostAck = false, initialCommit = null;
  const backend = {...realBackend, launch: async (...args) => {
    launches++; assert.equal(stage, "seed", "Recovery must not launch another command");
    return realBackend.launch(...args);
  }};
  const records = {readProcesses: id => store.readProcesses(id), async commitProcess(value) {
    await store.commitProcess(value);
    if (value.initialDelivery !== null && initialCommit === null) initialCommit = structuredClone(value);
    if (scenario === "receipt_ack_lost" && stage === "seed" && value.initialDelivery !== null && !lostAck) {
      lostAck = true; throw new Error("Injected lost acknowledgement after the SQLite commit");
    }
  }};
  const facts = [];
  manager = new RunProcessManager({backend, records, maximumActive: 2, maximumSettled: 2,
    observer: fact => {
      facts.push(fact); inspection.processObserver(fact);
    },
    ...(scenario === "retention_failed" ? {retainOutput: async () => {throw new Error("Injected retention failure");}} : {})});
  const marker = join(directory, "executions.txt");
  const receiptPath = join(directory, "receipt.json");
  if (stage === "seed") {
    const workspace = join(directory, "workspace"); await mkdir(workspace);
    const largeSearch = scenario.startsWith("search_");
    const capturedBytes = largeSearch ? 880000 : 66000;
    const payload = `const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(marker)},'once\\n');
      process.stdout.write('historical-'.repeat(${largeSearch ? 80000 : 6000}),()=>{fs.writeFileSync('ready','1');
        const timer=setInterval(()=>{if(!fs.existsSync('release'))return; clearInterval(timer);
          process.stdout.write('new-tail',()=>process.exit(0));},10);});`;
    const paths = {stdout: join(directory, "out.raw"), stderr: join(directory, "err.raw"),
      stdoutText: join(directory, "out.txt"), stderrText: join(directory, "err.txt"), manifest: join(directory, "output.json")};
    await manager.start({runId, executionId, actionId: "start-action", origin: {invocationId: "call", runActionId: "run-action", attemptId: "attempt"},
      environmentId: "verification", executable: process.env.HELARC_VERIFICATION_NODE, args: ["-e", payload], cwd: workspace,
      environment: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)), timeoutMs: 30000,
      deadlineAt: new Date(Date.now() + 60000).toISOString(), runSignal: new AbortController().signal, paths,
      maximumOutputBytes: largeSearch ? 1000000 : 100000, background: true});
    await until(() => manager.get(runId, executionId).output.retainedBytes >= capturedBytes);
    const before = scenario.startsWith("receipt_");
    let initial;
    if (before) initial = await manager.observe({runId, executionId, invocationId: "initial", initial: true, waitMs: 0, signal: new AbortController().signal});
    await writeFile(join(workspace, "release"), "1");
    await until(() => manager.get(runId, executionId).phase === "settled");
    if (!before) initial = await manager.observe({runId, executionId, invocationId: "initial", initial: true, waitMs: 0, signal: new AbortController().signal});
    assert(initial.hasMore); assert.notEqual(initial.nextCursor, initial.availableOutputCursor);
    const receipt = {runId, executionId, runActionId: "outer-shell-action", settlementId: "settlement",
      observationId: scenario === "initial_missing" ? null : initial.id, cursor: scenario === "initial_missing" ? null : initial.nextCursor};
    await writeFile(receiptPath, JSON.stringify({receipt, initial}));
    if (scenario !== "receipt_before") {
      if (scenario === "receipt_ack_lost") await assert.rejects(manager.commitInitialDelivery(receipt));
      else await manager.commitInitialDelivery(receipt);
      assert(initialCommit);
      if (before) assert.equal(initialCommit.notifications.length, 1, "Receipt and accumulated later facts commit atomically");
    } else await manager.flushRun(runId);
    assert.equal(launches, 1);
    if (largeSearch) {
      const input={query:"new-tail",references:[initial.materials[0].reference]};
      if (scenario==="search_prepared") {
        const progress=await store.contextMaterialRequest({kind:"search",runId,invocationId:"tail-search",input});
        assert.equal(progress.kind,"search_progress");
        await inspection.recorder.flush(); app.exit(73); return;
      }
      const search=await store.contextMaterials.search(runId,input,new AbortController().signal,"tail-search");
      assert.equal(search.exhausted,true); assert.equal(search.scannedBytes,880008);
      assert.equal(search.matches[0].byteStart,880000);
      await writeFile(join(directory,"seed-search.json"),JSON.stringify(search));
    }
    await inspection.recorder.flush();
    assert.equal(inspection.recorder.health().rejected, 0);
    await writeFile(join(directory, "seed-facts.json"), JSON.stringify(facts));
    await inspection.close(); inspection = null;
    // All selected progress is committed; intentionally omit graceful store/finalizer shutdown.
    app.exit(73);
    return;
  }
  const {receipt, initial} = JSON.parse(await readFile(receiptPath, "utf8"));
  await manager.restoreRun(runId);
  const observed = await manager.observe({runId, executionId, invocationId: "initial", initial: true, waitMs: 0, signal: new AbortController().signal});
  assert.deepEqual(observed, initial);
  await manager.commitInitialDelivery(receipt); await manager.commitInitialDelivery(receipt);
  const notifications = manager.readInputNotifications(runId, 0);
  if (scenario.startsWith("receipt_")) {
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].data.capture.stdout.text, "new-tail");
    assert.equal(notifications[0].data.capture.previousCursor, initial.availableOutputCursor);
    assert.equal(notifications[0].data.phase, "settled");
  } else if (scenario === "initial_missing") {
    assert.equal(notifications.length, 1); assert(notifications[0].data.capture.hasMore);
  } else assert.equal(notifications.length, 0);
  assert(manager.readOutput(runId, executionId, initial.nextCursor).stdout.text.length > 0);
  const status=await manager.observeCommand({runId,executionId,invocationId:"recovered-status",request:{until:"snapshot",waitMs:0},
    signal:new AbortController().signal,deadlineAt:new Date(Date.now()+60_000).toISOString()});
  const reference=scenario.startsWith("search_") ? initial.materials[0].reference : status.materials[0].reference;
  const search=await store.contextMaterials.search(runId,{query:"new-tail",references:[reference]},new AbortController().signal,"tail-search");
  assert.equal(search.matches.length,1);
  if (scenario.startsWith("search_")) {
    assert.equal(search.exhausted,true); assert.equal(search.stopReason,"scope_exhausted");
    assert.equal(search.scannedBytes,880008); assert.equal(search.matches[0].byteStart,880000);
    if (scenario==="search_result") assert.deepEqual(search,JSON.parse(await readFile(join(directory,"seed-search.json"),"utf8")));
  }
  const oldPage=await store.contextMaterials.read(runId,{reference:initial.materials[0].reference},new AbortController().signal,"old-page");
  assert(oldPage.text.startsWith("historical-"));
  assert.equal(await readFile(marker,"utf8"),"once\n"); assert.equal(launches,0);
  const checkpoint=(await store.readProcesses(runId))[0];
  await assert.rejects(store.commitProcess({...checkpoint,revision:checkpoint.revision+1,announcedOutputCursor:"invalid"}));
  await assert.rejects(store.commitProcess({...checkpoint,revision:checkpoint.revision+1,materialViews:[]}));
  await assert.rejects(store.contextMaterials.read("foreign",{reference},new AbortController().signal,"foreign"));
  await store.contextMaterialRetention.accept({id:"share-output",sourceRunId:runId,recipientRunId:"child",references:[reference],basis:{kind:"assignment",id:"assignment"}});
  assert((await store.contextMaterials.read("child",{reference},new AbortController().signal,"child-read")).text.startsWith("historical-"));
  await assert.rejects(manager.observeCommand({runId:"child",executionId,invocationId:"foreign-observe",request:{until:"snapshot",waitMs:0},
    signal:new AbortController().signal,deadlineAt:new Date(Date.now()+1000).toISOString()}));
  if (scenario==="retention_failed") assert.equal(checkpoint.snapshot.output.persistence,"failed");
  const dataPath = join(directory, "resumed.json");
  const data = {notifications, initial, search};
  if (stage === "resume") await writeFile(dataPath, JSON.stringify(data));
  else {
    assert.deepEqual(data, JSON.parse(await readFile(dataPath, "utf8")));
    await writeFile(join(directory, "verification.json"), JSON.stringify({scenario, executions: 1, notifications: notifications.length,
      exactObservation: true, exactSearch: true, retainedHistoricalPages: true, duplicateNotifications: 0, ownershipChecks: true}));
  }
  await inspection.recorder.flush(); assert.equal(inspection.recorder.health().rejected, 0);
}
main().catch(error => {console.error(error); process.exitCode = 1;}).finally(async () => {
  await manager?.finalizeRun({runId, deadlineAt: new Date(Date.now() + 3000).toISOString(), signal: new AbortController().signal}).catch(() => {});
  await store?.close(); await inspection?.close(); app.exit(process.exitCode ?? 0);
});
