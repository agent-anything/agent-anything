const {app, safeStorage} = require("electron");
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const {createHash} = require("node:crypto");
const {join} = require("node:path");
const {pathToFileURL} = require("node:url");
const {mkdir, readFile, writeFile, appendFile, access} = require("node:fs/promises");
const [directory, scenario, stage] = process.argv.slice(2);
const interruptedScenario = ["interrupted", "reply_recovery"].includes(scenario);
const replyRecovery = scenario === "reply_recovery";
const report = "The command appended exactly one marker. Its output was: effect committed once. No second execution was needed.";
app.setPath("userData", join(directory, "electron-user-data"));
app.disableHardwareAcceleration();
globalThis.fetch = async () => {throw new Error("No network is used by this verification");};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description) {
  const end = Date.now() + 60_000;
  while (!await predicate()) {if (Date.now() > end) throw new Error(`Timed out: ${description}`); await delay(20);}
}
async function exists(path) {try {await access(path); return true;} catch {return false;}}

// FileShare.Read permits reading but denies the delete-sharing required by rename.
async function holdFile(path) {
  const script = `$f=[System.IO.File]::Open('${path.replaceAll("'", "''")}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); try { [Console]::WriteLine('LOCKED'); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }`;
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    {windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
  let output = "";
  const closed = new Promise(resolve => child.once("close", resolve));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {child.kill(); reject(new Error(`File lock startup timed out: ${output}`));}, 15_000);
    child.stdout.on("data", text => {output += text; if (output.includes("LOCKED")) {clearTimeout(timer); resolve();}});
    child.stderr.on("data", text => {output += text;});
    child.once("error", error => {clearTimeout(timer); reject(error);});
    child.once("close", () => {clearTimeout(timer); if (!output.includes("LOCKED")) reject(new Error(output));});
  });
  return async () => {child.stdin.end("\n"); await closed;};
}

async function main() {
  await app.whenReady();
  assert(safeStorage.isEncryptionAvailable());
  const load = path => import(pathToFileURL(join(__dirname, "../../dist/main", path)).href);
  const {HelarcMainController} = await load("HelarcMainController.js");
  const {FileHelarcThreadStore} = await load("thread/FileHelarcThreadStore.js");
  const {HelarcExecutionStore} = await load("execution-storage/HelarcExecutionStore.js");
  const {ElectronSafeStorageCredentialCipher} = await load("provider/ElectronSafeStorageCredentialCipher.js");
  const {FileHelarcRunTranscriptStore} = await load("run-transcript/FileHelarcRunTranscriptStore.js");
  const {HelarcPersistenceDiagnostics} = await load("persistence/HelarcPersistenceDiagnostics.js");
  const {SerializedAtomicFile} = await load("persistence/SerializedAtomicFile.js");
  const {createFakeProviderContext} = await import("@agent-anything/test-support");
  const {createModelTurnId, createModelCallRef, snapshotModelCallableRequest, snapshotProviderResponse} = await import("@agent-anything/model-interaction");
  const {createRunTranscriptRecord} = await import("@agent-anything/agent-runtime/transcript");
  const {HOST_COMMAND_VERSION} = await import("@agent-anything/host/transport");
  const workspace = join(directory, "workspace"), marker = join(workspace, "effects.txt"), threadPath = join(directory, "threads.json");
  await mkdir(workspace, {recursive: true});
  const execution = await HelarcExecutionStore.open(join(directory, "execution"), undefined, undefined, undefined, undefined, new ElectronSafeStorageCredentialCipher());
  const threads = new FileHelarcThreadStore(threadPath);
  const diagnostics = new HelarcPersistenceDiagnostics(join(directory, `persistence-${stage}.json`));
  const diagnosticRecords = [];
  const record = diagnostics.record.bind(diagnostics);
  diagnostics.record = async value => {diagnosticRecords.push(value); await record(value);};
  let releaseLock = null, lockStarted = false, providerCalls = 0, releaseResponse;
  const responseGate = new Promise(resolve => {releaseResponse = resolve;});
  const context = createFakeProviderContext("projection-verification", "deterministic-model");
  const provider = {modelContext: context.modelContext, requestBodyTransportLimit: context.requestBodyTransportLimit,
    descriptor: {id: "projection-verification", name: "Projection verification", metadata: {}, requestRetryScheduler: {kind: "harness"}, capabilities: {
      nativeToolInteraction: {supported: true, callableDefinitions: true, modelCalls: true, resultMessages: true, multipleCalls: true, callCorrelation: "provider_supplied"},
      structuredGeneration: {supported: true}, streaming: {supported: false}, continuation: {supported: false}, compaction: {supported: false},
      modelContext: {capacity: context.modelContext.capacity, requestedOutput: context.modelContext.requestedOutput, inputPreservation: context.modelContext.inputPreservation},
      usageMetering: {inputTokens: "unavailable", outputTokens: "unavailable", costUnits: "unavailable"}}},
    async send(request) {
      providerCalls++;
      await appendFile(join(directory, `requests-${stage}.jsonl`), JSON.stringify(request) + "\n");
      assert.equal(request.interaction.kind, "native_tool_turn");
      const first = stage === "seed" && providerCalls === 1;
      const ordinaryReport = replyRecovery && stage === "seed" && providerCalls === 2;
      if (!first) {
        assert.equal(await readFile(marker, "utf8"), "x");
        const calls = request.messages.flatMap(m => m.content).filter(b => b.kind === "model_tool_call" && b.call.name.startsWith("PowerShell_"));
        const results = request.messages.flatMap(m => m.content).filter(b => b.kind === "model_tool_result" && calls.some(c => c.call.modelCallRef.id === b.result.modelCallRef.id));
        assert.equal(calls.length, 1, "Historical command call remains exactly once");
        assert.equal(results.length, 1, "Historical command result remains exactly once");
        const presentation = results[0].result;
        assert.equal(presentation.content.output.execution, "started");
        assert.equal(presentation.content.output.stdout.text.trim(), "effect committed once");
        assert.equal(presentation.content.output.stdout.segments, undefined);
        assert.equal(presentation.content.output.execution_descriptor, undefined);
        assert.equal(presentation.content.composite, undefined);
        if (stage === "seed" && !ordinaryReport) await writeFile(join(directory, "selected-presentation.json"), JSON.stringify(presentation));
        if (stage === "resume") assert.deepEqual(presentation, JSON.parse(await readFile(join(directory, "selected-presentation.json"), "utf8")),
          "Recovery delivers the exact retained presentation, not a regenerated result");
        if (replyRecovery && !ordinaryReport) {
          const blocks = request.messages.flatMap(m => m.content);
          assert.equal(blocks.filter(b => b.kind === "text" && b.text === report).length, 1);
          assert(JSON.stringify(request.messages).includes("without response"), "Retained feedback explains adoption");
          assert(JSON.stringify(request.messages).includes("arguments {}"), "No-Plan feedback supplies a valid ending call");
        }
        if (stage === "seed" && scenario !== "terminal_delivery" && !ordinaryReport) await responseGate;
      }
      const responseId = `${stage}:${providerCalls}`, turnId = createModelTurnId({providerId: provider.descriptor.id, requestId: request.requestId, responseId});
      const name = first ? request.interaction.callables.find(c => c.name.startsWith("PowerShell_")).name : "final_result";
      const input = first ? {command: "[System.IO.File]::AppendAllText('effects.txt', 'x'); Write-Output 'effect committed once'", timeout_ms: 10000, wait_ms: 10000} : replyRecovery ? {} : {response: "Completed once."};
      const content = ordinaryReport ? [{kind: "text", text: report}] : [{kind: "model_tool_call", call: snapshotModelCallableRequest({
        modelCallRef: createModelCallRef({providerRequestId: request.requestId, controllerRequestId: request.correlation.controllerRequestId,
          turnId, contentBlockOrdinal: 0, branchId: request.correlation.branchId}), providerCallRef: {providerId: provider.descriptor.id, id: responseId},
        name, input, ordinal: 0})}];
      return {kind: "succeeded", response: snapshotProviderResponse({kind: "native_tool_turn", turn: {turnId, assistant: {role: "assistant", content},
        finish: {kind: "normal"}, usage: null, responseRef: {providerId: provider.descriptor.id, requestId: request.requestId, responseId}}, continuation: null, metadata: {}})};
    }};
  const controller = new HelarcMainController({commandOutputDirectory: join(directory, "output"), threadStore: threads,
    executionStore: execution, persistenceDiagnostics: diagnostics, provider: stage === "seed" ? provider : null,
    recoverProvider: async () => {assert(interruptedScenario, "Terminal delivery must not reconnect Provider"); return provider;},
    runTranscriptPort: new FileHelarcRunTranscriptStore(join(directory, "transcripts"))});
  const approved = new Set();
  controller.subscribeSnapshot(snapshot => {
    for (const pending of snapshot.run?.host.pendingInteractions ?? []) {
      if (pending.request.protocol.kind !== "approval" || approved.has(pending.request.id)) continue;
      approved.add(pending.request.id);
      const presentation = pending.presentation, option = presentation.decisionOptions.find(value => value.kind === "accept");
      assert(option, "Approval must use an offered decision");
      const submissionId = `approve-${approved.size}`;
      void controller.dispatchHostCommand({version: HOST_COMMAND_VERSION, commandId: submissionId, runId: presentation.runId, kind: "interaction.submit",
        payload: {request: pending.request, submissionId, payload: {submissionId, runId: presentation.runId, requestId: presentation.id,
          pendingVersion: pending.request.requestVersion, optionId: option.id, grantedPermissions: null, reason: null}}}, "interaction.submit");
    }
  });
  try {
    if (stage === "seed") {
      // Also exercise a successful short lock inside a single atomic replacement.
      const probe = join(directory, "probe.json"); await writeFile(probe, "old");
      const release = await holdFile(probe);
      const releaseTimer = setTimeout(() => {void release();}, 120);
      let writeReport;
      await new SerializedAtomicFile(probe).transact(tx => tx.replaceText("new"), value => {writeReport = value;});
      clearTimeout(releaseTimer);
      assert(writeReport.replacementAttempts > 1); assert.equal(await readFile(probe, "utf8"), "new");
      const commitProjection = threads.commitRunProjection.bind(threads);
      const projectionCommits = new Map();
      let latestSaved = 0, exactRetries = 0;
      threads.commitRunProjection = async commit => {
        const previous = projectionCommits.get(commit.commitId);
        if (previous) {assert.deepEqual(commit, previous); exactRetries++;}
        else projectionCommits.set(commit.commitId, structuredClone(commit));
        if (!lockStarted && await exists(marker)) {lockStarted = true; releaseLock = await holdFile(threadPath);}
        const result = await commitProjection(commit);
        assert.notEqual(result.status, "rejected", JSON.stringify(result));
        assert(commit.projectionSequence >= latestSaved, "An old snapshot must not overwrite newer progress");
        latestSaved = commit.projectionSequence;
        return result;
      };
      controller.selectWorkspacePath(workspace);
      const started = await controller.startRun({taskText: "Append one marker exactly once, then finish.", target: {kind: "new_thread"}});
      assert.equal(started.ok, true, JSON.stringify(started));
      await until(() => providerCalls === (replyRecovery ? 3 : 2), "command result and retained reply request");
      if (scenario === "quiet_retry") {
        await until(() => controller.activeRunSlot.retryWait !== null && controller.activeRunSlot.pendingProjection !== null, "quiescent failed snapshot");
        const sequence = controller.activeRunSlot.projectionSequence;
        await releaseLock(); releaseLock = null;
        await until(() => diagnosticRecords.some(value => value.outcome === "recovered"), "save catches up without another event");
        assert.equal(controller.activeRunSlot.projectionSequence, sequence, "No new projection caused retry");
        assert.equal(controller.getSnapshot().error, null);
        assert.equal((await threads.loadThread(started.threadId)).runs[0].projectionSequence, sequence);
        releaseResponse();
        await until(() => controller.getSnapshot().execution === "idle", "normal final delivery");
      } else if (interruptedScenario) {
        await until(() => !controller.activeRunSlot.progressWriting && controller.activeRunSlot.pendingProjection !== null, "bounded retries exhausted");
        assert.equal(controller.getSnapshot().error.code, "run_persistence_failed");
      } else {
        await until(() => controller.getSnapshot().execution === "idle", "terminal save fails while file remains locked");
        assert.equal(controller.getSnapshot().error.code, "run_persistence_failed");
        assert(diagnosticRecords.some(value => value.operation === "run_terminal" && value.outcome === "failed"));
      }
      const [entry] = await execution.listProductRuns();
      const checkpoint = await execution.readLatestRun(entry.admission.rootRunId);
      await writeFile(join(directory, "seed.json"), JSON.stringify({id: entry.admission.rootRunId, threadId: started.threadId, productRunId: entry.admission.productRunId,
        items: checkpoint.state.items, terminal: entry.terminal, delivered: entry.delivered}));
      assert.equal(entry.delivered, scenario === "quiet_retry");
      assert.equal(entry.terminal, !interruptedScenario);
      if (scenario !== "terminal_delivery") assert(exactRetries > 0, "Retry reuses the entire original commit");
      const failures = diagnosticRecords.filter(value => value.outcome === "failed");
      assert(failures.length > 0);
      assert(failures.every(value => value.code === "EPERM" && value.error.fields.stage === "replace" && value.writeReport.replacementAttempts === 6));
      assert(failures.every(value => value.attempt <= 3), "Projection retry must remain bounded");
      if (interruptedScenario) assert.equal(failures.at(-1).attempt, 3);
      if (releaseLock) {await releaseLock(); releaseLock = null;}
      if (interruptedScenario) {app.exit(73); return;}
    } else {
      const seed = JSON.parse(await readFile(join(directory, "seed.json"), "utf8"));
      const entries = await controller.listRecoverableWork();
      if (stage === "resume" && scenario !== "quiet_retry") {
        assert.equal(entries.length, 1);
        assert.equal(entries[0].state, interruptedScenario ? "interrupted" : "delivery_pending");
        assert.equal((await controller.recoverWork({id: seed.id, revision: entries[0].revision - 1, intent: "continue"})).ok, false, "Stale recovery request must still fail");
        const result = await controller.recoverWork({id: seed.id, revision: entries[0].revision, intent: "continue"});
        assert.equal(result.ok, true, JSON.stringify(result));
        await until(() => controller.getSnapshot().execution === "idle", "recovered result delivery");
        if (scenario === "terminal_delivery") assert(diagnosticRecords.some(value =>
          value.outcome === "recovered" && value.code === "terminal_delivery_recovered" && value.runId === seed.productRunId));
      } else assert.equal(entries.length, 0);
      assert.equal(providerCalls, stage === "resume" && interruptedScenario ? 1 : 0);
      assert.equal(await readFile(marker, "utf8"), "x", "A completed effect must not execute again");
      const [entry] = await execution.listProductRuns();
      assert.equal(entry.terminal, true); assert.equal(entry.delivered, true);
      const checkpoint = await execution.readLatestRun(seed.id);
      assert.deepEqual(checkpoint.state.items.slice(0, seed.items.length), seed.items, "Acknowledged progress is retained exactly");
      const transcriptPath = join(directory, "transcripts", `${createHash("sha256").update(seed.id).digest("hex")}.jsonl`);
      const records = (await readFile(transcriptPath, "utf8")).trim().split("\n").map(JSON.parse);
      assert.deepEqual(records, checkpoint.state.items.map(createRunTranscriptRecord), "No missing or duplicated interaction records");
      const thread = await threads.loadThread(seed.threadId);
      assert.equal(thread.messages.filter(message => message.role === "assistant").length, 1);
      if (replyRecovery) assert(JSON.stringify(thread.messages).includes(report), "The retained report is adopted, not replaced by an acknowledgement");
      assert(checkpoint.state.items.some(item => item.payload.kind === "observation" &&
        item.payload.observation.payload.result?.metadata?.compositeSettlement), "Raw composite evidence remains recoverable");
      assert.equal(thread.runs[0].terminal.host.status, "completed");
      assert.equal((await controller.listRecoverableWork()).length, 0);
      if (stage === "verify") {
        const original = await readFile(threadPath, "utf8");
        try {
          await writeFile(threadPath, '{"formatVersion":5,"aggregates":[{"invalid":true}]}');
          await assert.rejects(threads.loadThread(seed.threadId), {code: "thread_store_corrupt"});
          assert((await readFile(threadPath, "utf8")).includes('"invalid":true'), "Corruption must not be silently reset");
        } finally {await writeFile(threadPath, original);}
      }
      await writeFile(join(directory, "verification.json"), JSON.stringify({scenario, effects: 1, assistantMessages: 1,
        providerCalls, transcriptItems: records.length, retainedItems: seed.items.length, terminal: true, delivered: true}));
    }
  } finally {
    if (releaseLock) await releaseLock();
    await execution.close();
  }
}
main().then(() => app.exit(0), error => {console.error(error); app.exit(1);});
