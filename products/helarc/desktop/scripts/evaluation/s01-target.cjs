const {app} = require("electron");
const assert = require("node:assert/strict");
const {createServer} = require("node:http");
const {createHash} = require("node:crypto");
const {createWriteStream} = require("node:fs");
const {isDeepStrictEqual} = require("node:util");
const {mkdir, readFile, writeFile, appendFile, readdir} = require("node:fs/promises");
const {join} = require("node:path");
const {pathToFileURL} = require("node:url");
const [directory, mode = "live", upstream = "http://localhost:11435"] = process.argv.slice(2);
const followupOnly = process.argv.includes("--continue-terminal");
assert(directory && ["live", "denial"].includes(mode));
app.setPath("userData", join(directory, "electron"));
app.disableHardwareAcceleration();
const digest = value => createHash("sha256").update(value).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2));
let controller, host, store, inspection, server, query;
let logTail = Promise.resolve(), ended = false, round = 0, requestCount = 0, denied = false, performanceStream;
let performanceFailure;
const handlers = new Set(), requests = new Set();
const log = (name, value) => logTail = logTail.then(() => appendFile(join(directory, name), JSON.stringify(value) + "\n"));
const source = "name,value\na,7\nb,12\nb,8\n";
const initial = "Read source.csv in the workspace. Group by name and sum the values, sort by name, and write result.csv with columns name,value. Do not modify source.csv.";
const correction = "Keep source.csv unchanged. For this calculation, use 9 for the second b row instead of its original value, and update result.csv.";

async function main() {
  await mkdir(directory, {recursive: true});
  await app.whenReady();
  const load = path => import(pathToFileURL(join(__dirname, "../../dist/main", path)).href);
  const {HelarcMainController} = await load("HelarcMainController.js");
  const {HelarcExecutionStore} = await load("execution-storage/HelarcExecutionStore.js");
  const {FileHelarcThreadStore} = await load("thread/FileHelarcThreadStore.js");
  const {ElectronSafeStorageCredentialCipher} = await load("provider/ElectronSafeStorageCredentialCipher.js");
  const {createHelarcActivityHost} = await load("context/HelarcActivityHost.js");
  const {HelarcInspection} = await load("inspection/HelarcInspection.js");
  const {createHelarcProviderProfile, createDefaultHelarcInstructionSettings, createDefaultHelarcContextSettings} = await import("@agent-anything/helarc/configuration");
  const {HOST_COMMAND_VERSION} = await import("@agent-anything/host/transport");
  const {APPROVAL_INTERACTION_PROTOCOL} = await import("@agent-anything/permission");
  const {OllamaProvider} = await import("@agent-anything/provider-integrations/ollama");
  const {InspectionQueryService} = await import("@agent-anything/inspection/query");
  const workspace = join(directory, "workspace");
  if (followupOnly) {
    assert.equal(await readFile(join(workspace, "source.csv"), "utf8"), source);
    round = 1;
    requestCount = (await readdir(directory)).filter(name => /^request-\d+\.json$/.test(name)).length;
  } else {
    await mkdir(workspace);
    await writeFile(join(workspace, "source.csv"), source, {flag: "wx"});
  }
  await save(followupOnly ? "expectation-followup.json" : "expectation.json", {case: "P57-S01-v1", evidence: mode === "live" ? "R" : "D", sourceDigest: digest(source),
    initial, correction, expected: ["name,value\na,7\nb,20\n", "name,value\na,7\nb,21\n"],
    stimulus: "after first Run terminal and actual file read; continue original thread", model: "gemma4:e4b", upstream,
    deadlineMs: 600000, instructions: "default disabled", approval: "result.csv file changes allowed; other actions require explicit decision file; first write declined in D",
    limits: ["single sample", "no crash injection", "no semantic quality inference from D"]});
  const instructions = createDefaultHelarcInstructionSettings();
  await save(followupOnly ? "configuration-followup.json" : "configuration.json", {instructions, context: createDefaultHelarcContextSettings(), versions: process.versions});
  server = createServer((req, res) => {
    const abort = new AbortController(); requests.add(abort);
    const job = (async () => {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {bytes += chunk.length; if (bytes > 16000000) throw new Error("capture_bound"); chunks.push(chunk);}
      const raw = Buffer.concat(chunks).toString("utf8"), body = JSON.parse(raw), number = ++requestCount;
      const prefix = `request-${String(number).padStart(3, "0")}`;
      await writeFile(join(directory, `${prefix}.json`), raw);
      await log("provider.jsonl", {kind: "request", number, round, at: new Date().toISOString(), url: req.url, digest: digest(raw), bytes});
      const started = performance.now();
      let status, response;
      if (mode === "live") {
        const received = await fetch(`${upstream}${req.url}`, {method: "POST", headers: {"content-type": "application/json"}, body: raw, signal: abort.signal});
        status = received.status; response = await received.text();
      } else {
        const scripted = round === 1
          ? [["Read", {file_path: "source.csv"}], ["Write", {file_path: "result.csv", content: "name,value\na,7\nb,20\n"}],
            ["Write", {file_path: "result.csv", content: "name,value\na,7\nb,20\n"}], ["final_result", {response: "Written result.csv: a=7, b=20. Source unchanged."}]]
          : [["Read", {file_path: "source.csv"}], ["Write", {file_path: "result.csv", content: "name,value\na,7\nb,21\n"}],
            ["final_result", {response: "Updated result.csv: a=7, b=21. Source unchanged."}]];
        const step = scripted[round === 1 ? number - 1 : number - 5];
        assert(step, "Unexpected extra request in controlled protocol");
        const name = body.tools.map(tool => tool.function.name).find(name => name === step[0] || name.startsWith(`${step[0]}_`));
        assert(name, "Required callable must actually be exposed");
        response = JSON.stringify({model: body.model, created_at: new Date().toISOString(), message: {role: "assistant", content: "",
          tool_calls: [{function: {name, arguments: step[1]}}]}, done: true, done_reason: "stop", prompt_eval_count: 1000, eval_count: 50});
        status = 200;
      }
      await writeFile(join(directory, `${prefix}-response.json`), response);
      await log("provider.jsonl", {kind: "response", number, round, at: new Date().toISOString(), status, elapsedMs: performance.now() - started});
      res.writeHead(status, {"content-type": "application/json"}); res.end(response);
    })().catch(async error => {
      await log("provider.jsonl", {kind: "failure", message: error.message});
      if (!res.destroyed) {res.writeHead(500); res.end(JSON.stringify({error: error.message}));}
    });
    handlers.add(job); void job.finally(() => {handlers.delete(job); requests.delete(abort);});
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const settings = {model: mode === "live" ? "gemma4:e4b" : "controlled-s01", baseUrl: endpoint, timeoutMs: 120000,
    think: false, nativeToolInteraction: {supported: true}, runtime: {contextWindowTokens: 163840},
    requestBodyTransportLimit: {maximumBytes: 16000000, source: "host_configured", revision: "1"}};
  const provider = new OllamaProvider(settings);
  const profile = createHelarcProviderProfile({id: "s01", providerKind: "ollama", displayName: "S01 isolated", baseUrl: endpoint,
    model: settings.model, timeoutMs: settings.timeoutMs, ollamaRuntime: {contextWindowTokens: 163840}, credentialStatus: "empty_allowed", isActive: true});
  assert(profile.ok);
  inspection = await HelarcInspection.create(join(directory, "inspection-settings.json"), join(directory, "inspection"));
  assert(inspection?.recorder, "Recording must be available");
  await log("recordings.jsonl", {phase: "opened", sourceId: inspection.recorder.source.sourceId, datasetId: inspection.recorder.manifest.datasetId});
  performanceStream = createWriteStream(join(directory, "performance.jsonl"), {flags: "a"});
  performanceStream.on("error", error => {performanceFailure = error;});
  const diagnostics = {record: event => {void log("diagnostics.jsonl", event);}, performance: event => {
    inspection.performanceObserver?.performance(event);
    if (performanceStream.writableLength > 16000000) {performanceFailure ??= new Error("performance_capture_backpressure"); return;}
    performanceStream.write(JSON.stringify(event) + "\n");
  }};
  store = await HelarcExecutionStore.open(join(directory, "execution"), undefined, inspection.evidenceObserver,
    inspection.fileMaterialObserver, diagnostics, new ElectronSafeStorageCredentialCipher(), inspection.contextMaterialObserver,
    inspection.activityObserver, inspection.contextFoundationObserver);
  host = createHelarcActivityHost(store, {executionFlow: inspection.executionFlow, diagnostics});
  const threadStore = new FileHelarcThreadStore(join(directory, "threads.json"));
  controller = new HelarcMainController({provider, providerProfile: profile.profile, instructionSettings: instructions,
    executionStore: store, activityHost: host, recoverProvider: async () => provider, inspection, threadStore,
    threadSummaries: await threadStore.listThreadSummaries(),
    executionDiagnostics: diagnostics, commandOutputDirectory: join(directory, "command-output")});
  controller.selectWorkspacePath(workspace);
  const seen = new Set(), outcomes = [];
  const run = async (prompt, target) => {
    round++;
    await log("stimuli.jsonl", {round, prompt, target, at: new Date().toISOString()});
    const result = await controller.startRun({taskText: prompt, target});
    await save(`round-${round}-start.json`, result); assert(result.ok, JSON.stringify(result));
    const deadline = Date.now() + 600000;
    for (;;) {
      const snapshot = controller.getSnapshot();
      if (snapshot.execution === "idle") {
        await save(`round-${round}-terminal.json`, snapshot);
        const tree = await store.readRunTree(snapshot.run.harnessRunId);
        await save(`round-${round}-execution.json`, tree);
        const actual = await readFile(join(workspace, "result.csv"), "utf8").catch(error => {if (error.code === "ENOENT") return null; throw error;});
        const currentSource = await readFile(join(workspace, "source.csv"));
        const outcome = {round, status: snapshot.status, runId: snapshot.run.harnessRunId, productRunId: snapshot.run.productRunId,
          threadId: snapshot.activeThread.id, result: actual, sourceUnchanged: digest(currentSource) === digest(source), at: new Date().toISOString()};
        outcomes.push(outcome); await save(`round-${round}-effect.json`, outcome); console.log(JSON.stringify(outcome));
        return outcome;
      }
      for (const pending of snapshot.run?.host.pendingInteractions ?? []) {
        const identity = `${pending.request.id}:${pending.request.requestVersion}`;
        if (seen.has(identity)) continue;
        if (!isDeepStrictEqual(pending.request.protocol, APPROVAL_INTERACTION_PROTOCOL)) continue;
        const review = pending.presentation;
        const allowed = review.category === "fileChange" && review.payload.additionalPermissions === null &&
          review.payload.changes.length > 0 && review.payload.changes.every(change => change.displayPath === "result.csv" && ["create", "update"].includes(change.operation));
        const firstDenial = mode === "denial" && allowed && !denied;
        if (firstDenial) denied = true;
        let kind = allowed && !firstDenial ? "accept" : "decline";
        if (!allowed) {
          const key = digest(identity).slice(0, 16);
          await save(`approval-${key}.json`, {identity, pending});
          const decision = await readFile(join(directory, `decision-${key}.json`), "utf8").then(JSON.parse)
            .catch(error => {if (error.code === "ENOENT") return null; throw error;});
          if (!decision) continue;
          assert.equal(decision.identity, identity); assert(["accept", "decline"].includes(decision.kind));
          kind = decision.kind;
        }
        seen.add(identity);
        await log("interactions.jsonl", {kind: "presented", round, pending});
        if (mode === "denial" && review.category === "fileChange" && kind === "decline") denied = true;
        const option = review.decisionOptions.find(option => option.kind === kind); assert(option);
        const submissionId = `s01-${round}-${seen.size}`;
        const receipt = await controller.dispatchHostCommand({version: HOST_COMMAND_VERSION, commandId: submissionId,
          runId: snapshot.run.harnessRunId, kind: "interaction.submit", payload: {request: pending.request, submissionId,
            payload: {submissionId, runId: review.runId, requestId: review.id, pendingVersion: pending.request.requestVersion,
              optionId: option.id, grantedPermissions: null, reason: firstDenial ? "Predeclared first-write denial" : allowed ? "Authorized isolated result.csv" : "Explicit external test reviewer decision"}}}, "interaction.submit");
        const after = await readFile(join(workspace, "result.csv"), "utf8").catch(error => {if (error.code === "ENOENT") return null; throw error;});
        await log("interactions.jsonl", {kind: "submitted", round, identity, decision: kind, firstDenial, receipt, fileImmediatelyAfter: after});
      }
      if (performanceFailure) throw performanceFailure;
      if (Date.now() > deadline) throw new Error("S01 target deadline");
      await delay(40);
    }
  };
  const first = followupOnly ? JSON.parse(await readFile(join(directory, "round-1-effect.json"), "utf8")) : await run(initial, {kind: "new_thread"});
  if (followupOnly) {outcomes.push(first); assert((await controller.openThread(first.threadId)).ok);}
  assert.notEqual(first.result, null, "No initial result; correction condition not met");
  await run(correction, {kind: "continue_thread", threadId: first.threadId});
  await save("thread.json", await threadStore.loadThread(first.threadId));
  await host.service.close(); host = null;
  await store.close(); store = null;
  const registration = {sourceId: inspection.recorder.source.sourceId, datasetId: inspection.recorder.manifest.datasetId};
  await inspection.close();
  await save("recording.json", {...registration, health: inspection.recorder.health(), settings: inspection.snapshot().settings});
  query = new InspectionQueryService(join(directory, "inspection"));
  const snapshot = await query.query({kind: "get_snapshot", ...registration});
  let next, count = 0;
  do {
    const page = await query.query({kind: "list_records", ...snapshot.selection, limit: 500, ...(next ? {after: next} : {})});
    for (const record of page.records) await log("inspector-records.jsonl", record);
    count += page.records.length; next = page.next;
    if (count > 50000) throw new Error("S01 inspection capture bound");
  } while (next);
  await save("inspection-boundary.json", {selection: snapshot.selection, records: count});
  await query.close(); query = null;
  const parse = value => value?.trim().split(/\r?\n/).map(line => line.trim()).join("\n");
  await save("result.json", {case: "S01", mode, outcomes, requests: requestCount, denied,
    exactTextMatches: outcomes.map((outcome, i) => parse(outcome.result) === `name,value\na,7\nb,${i === 0 ? 20 : 21}`),
    sourceUnchanged: outcomes.every(outcome => outcome.sourceUnchanged), inspectionRecords: count});
}

async function close() {
  if (ended) return; ended = true;
  const snapshot = controller?.getSnapshot();
  if (snapshot?.execution === "active") {
    const {HOST_COMMAND_VERSION} = await import("@agent-anything/host/transport");
    await controller.dispatchHostCommand({version: HOST_COMMAND_VERSION, commandId: "s01-cleanup", runId: snapshot.run.harnessRunId,
      kind: "run.cancel", payload: {reason: "S01 verification ending"}}, "run.cancel").catch(() => {});
    const until = Date.now() + 30000;
    while (controller.getSnapshot().execution !== "idle" && Date.now() < until) await delay(50);
  }
  for (const abort of requests) abort.abort();
  if (server) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
  await Promise.allSettled([...handlers]);
  if (host) await host.service.close();
  if (store) {await store.close();store=null;}
  if (inspection) {
    await inspection.close();
    await log("recordings.jsonl", {phase: "closed", sourceId: inspection.recorder.source.sourceId,
      datasetId: inspection.recorder.manifest.datasetId, health: inspection.recorder.health()});
  }
  if (query) await query.close();
  await logTail;
  if (performanceStream) await new Promise((resolve, reject) => {performanceStream.once("error", reject); performanceStream.end(resolve);});
  if (performanceFailure) throw performanceFailure;
  await save("cleanup.json", {at: new Date().toISOString(), activeHandlers: handlers.size, execution: controller?.getSnapshot().execution ?? null});
}

main().then(async () => {await close(); app.exit(0);}).catch(async error => {
  await save("failure.json", {message: error.message, stack: error.stack}).catch(() => {});
  console.error(error);
  try {await close();} catch (cleanup) {await save("cleanup-failure.json", {message: cleanup.message});}
  app.exit(1);
});
