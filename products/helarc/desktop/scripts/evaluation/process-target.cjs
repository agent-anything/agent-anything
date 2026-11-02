const {app} = require("electron");
const {join} = require("node:path");
const {pathToFileURL} = require("node:url");
const {createHash} = require("node:crypto");
const {isDeepStrictEqual} = require("node:util");
const {mkdir, readFile, writeFile, appendFile} = require("node:fs/promises");
const [directory, mode, endpoint] = process.argv.slice(2);
app.setPath("userData", join(directory, "electron"));
app.disableHardwareAcceleration();
let store, host, inspection, execution;
let disconnected = false;
process.on("disconnect", () => {
  disconnected = true;
  if (execution) void execution.activeRun.cancel({origin: "user", reasonCode: "user_requested"}).catch(() => {});
  // The owning engineering process has disappeared; never leave an orphan Worker.
  setTimeout(() => app.exit(74), 5000).unref();
});
async function main() {
  await app.whenReady();
  const load = path => import(pathToFileURL(join(__dirname, "../../dist/main", path)).href);
  const {HelarcExecutionStore} = await load("execution-storage/HelarcExecutionStore.js");
  const {SerializedAtomicFile} = await load("persistence/SerializedAtomicFile.js");
  const saveObject = (file, value) => new SerializedAtomicFile(file).transact(transaction => transaction.replaceText(JSON.stringify(value)));
  const {ElectronSafeStorageCredentialCipher} = await load("provider/ElectronSafeStorageCredentialCipher.js");
  const {prepareHelarcHostRun} = await load("run/HelarcHostRunComposition.js");
  const {createHelarcActivityHost} = await load("context/HelarcActivityHost.js");
  const {HelarcInspection} = await load("inspection/HelarcInspection.js");
  const {createStaticHostIdentityResolver, createStaticHostWorkspaceResolver} = await import("@agent-anything/host/context");
  const {createHelarcTask} = await import("@agent-anything/helarc/task");
  const {APPROVAL_INTERACTION_PROTOCOL} = await import("@agent-anything/permission");
  const {createHelarcProviderProfile,createDefaultHelarcContextSettings} = await import("@agent-anything/helarc/configuration");
  const {OllamaProvider} = await import("@agent-anything/provider-integrations/ollama");
  const input = JSON.parse(await readFile(join(directory, "target-input.json"), "utf8"));
  const manifestFile = join(directory, "target-execution.json");
  const existing = await readFile(manifestFile, "utf8").then(JSON.parse).catch(error => {if (error.code === "ENOENT") return null; throw error;});
  if (existing && (existing.trialId !== input.trialRef.id || !isDeepStrictEqual(existing.bindings, input.branch))) throw new Error("Original target identity mismatch");
  inspection = await HelarcInspection.create(join(directory, "inspection-settings.json"), input.input.inspectionRoot??join(directory, "inspection"));
  if (inspection) await appendFile(join(directory, "recordings.jsonl"), JSON.stringify(inspection.recorder ? {
    phase: "opened", sourceId: inspection.recorder.source.sourceId, datasetId: inspection.recorder.manifest.datasetId,
  } : {phase: "opened", unavailable: true}) + "\n");
  async function closeRecording() {
    await inspection.close();
    await appendFile(join(directory, "recordings.jsonl"), JSON.stringify(inspection.recorder ? {
      phase: "closed", sourceId: inspection.recorder.source.sourceId, datasetId: inspection.recorder.manifest.datasetId,
      health: inspection.recorder.health(),settings:inspection.snapshot().settings,
    } : {unavailable: true}) + "\n");
  }
  store = await HelarcExecutionStore.open(join(directory, "execution"), undefined, inspection?.evidenceObserver,
    inspection?.fileMaterialObserver, undefined, new ElectronSafeStorageCredentialCipher(), inspection?.contextMaterialObserver,
    inspection?.activityObserver, inspection?.contextFoundationObserver);
  async function exportExecution(runId) {
    try {
      const tree = await store.readRunTree(runId);
      const snapshot = {generation: store.generation, treeRef: {id: tree.commit.id, revision: String(tree.commit.revision)},
        rootRunId: runId, members: tree.members.map(member => ({runId: member.head.state.run.id,
          status: member.head.state.status, revision: member.head.state.revision, items: member.head.state.items}))};
      const digest = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
      const file = `execution-snapshot-${digest}.json`;
      await saveObject(join(directory, file), snapshot);
      return {status: "available", file, digest, generation: store.generation, treeRef: snapshot.treeRef};
    } catch (error) {
      return {status: "unavailable", message: error.message};
    }
  }
  host = createHelarcActivityHost(store, {executionFlow: inspection.executionFlow});
  const model=input.input.model??"controlled-process-evaluation";
  const timeoutMs=input.input.comparison==="C04"?120000:60000;
  const provider = new OllamaProvider({model, baseUrl: endpoint, timeoutMs, think: false,
    nativeToolInteraction: {supported: true}, runtime: {contextWindowTokens: 163840},
    requestBodyTransportLimit: {maximumBytes: 16000000, source: "host_configured", revision: "1"}});
  const workspaceRoot = join(directory, "workspace"); await mkdir(workspaceRoot, {recursive: true});
  const workspace = {primary: {id: input.branch.workspaceId, name: "Isolated evaluation", rootRef: workspaceRoot,
    trustState: "trusted", source: "evaluation", policyRefs: [], metadata: {}}, additional: []};
  const task = createHelarcTask({taskId: input.trialRef.id, prompt: input.input.prompt, createdAt: "2026-11-01T00:00:00.000Z"}).task;
  const configured = createHelarcProviderProfile({id: input.branch.branchId, providerKind: "ollama", displayName: "Evaluation endpoint",
    baseUrl: endpoint, model, timeoutMs, ollamaRuntime: {contextWindowTokens: 163840}, credentialStatus: "empty_allowed"});
  if (!configured.ok) throw new Error(JSON.stringify(configured));
  const common = {provider, task, sessionId: input.branch.authorityId, productRunId: input.trialRef.id, inputItems: [], inspection,
    permissionPreset: "ask_for_approval", providerProfile: configured.profile, executionStore: store, activityHost: host,
    commandOutputDirectory: join(directory, "command-output"),
    ...(input.input.comparison==="C04"?{contextSettings:{...createDefaultHelarcContextSettings(),autoRepresentation:input.input.arm==="default"}}:{}),
    workspaceResolver: createStaticHostWorkspaceResolver(workspace),
    workspaceSelection: {kind: "references", primaryRef: workspace.primary.id, additionalRefs: []},
    identityResolver: createStaticHostIdentityResolver({id: input.branch.authorityId, kind: "anonymous", displayName: "Isolated evaluation", metadata: {}}),
    identitySelection: {kind: "anonymous"}};
  const admission = existing ? await store.readProductRun(existing.runId) : null;
  if (existing && !admission) throw new Error("Original execution admission unavailable");
  const prepared = await prepareHelarcHostRun({...common, ...(admission ? {task: admission.task, providerProfile: admission.providerProfile,
    instructionSettings: admission.instructionSettings, recoveryAdmission: admission} : {})});
  if (existing && existing.runId !== prepared.rootRunId) throw new Error("Evaluation recovery changed execution identity");
  if (disconnected) throw new Error("evaluation_owner_disconnected");
  if (!existing) await saveObject(manifestFile, {runId: prepared.rootRunId, trialId: input.trialRef.id, bindings: input.branch});
  if (mode === "interrupt-after-effect" && !existing) {
    const commit = store.commitExecutionEvidence.bind(store);
    store.commitExecutionEvidence = async fact => {
      await commit(fact);
      const effect = await readFile(join(workspaceRoot, "effect.txt"), "utf8").catch(error => {if (error.code === "ENOENT") return ""; throw error;});
      if (!effect.includes("x")) return;
      // Fault injection follows a public durable handoff, not a private snapshot edit.
      const captureExport = await exportExecution(prepared.rootRunId);
      await saveObject(join(directory, "interruption.json"), {runId: prepared.rootRunId,
        effectRunId: fact.source.correlation.run.id, generation: store.generation, captureExport});
      await closeRecording(); app.exit(73); await new Promise(() => {});
    };
  }
  execution = existing ? await prepared.recover() : prepared.start();
  process.on("message", async message => {
    if (message?.kind === "cancel") await execution.activeRun.cancel({origin: "user", reasonCode: "user_requested"});
  });
  const allowedCommand = process.platform === "win32" ? "[System.IO.File]::AppendAllText('effect.txt','x'); Write-Output 'effect recorded'" : "printf x >> effect.txt; printf 'effect recorded\\n'";
  const expectedCwd = `${workspace.primary.id}:.`;
  let ended = false, approvalFailure;
  const seenInteractions = new Set();
  const approvals = (async () => {
    while (!ended) {
      for (const pending of execution.activeRun.getStatus().pendingInteractions) {
        const review = pending.presentation, identity = `${pending.request.id}:${pending.request.requestVersion}`;
        if (seenInteractions.has(identity)) continue;
        seenInteractions.add(identity);
        if (!isDeepStrictEqual(pending.request.protocol, APPROVAL_INTERACTION_PROTOCOL)) {
          await appendFile(join(directory, "interaction-events.jsonl"), JSON.stringify({request: pending.request,
            runId: pending.runId, disposition: "awaiting_external_input", presentation: review}) + "\n");
          continue;
        }
        const allowed = review.category === "commandExecution" && review.payload.commandDisplay === allowedCommand &&
          review.payload.additionalPermissions === null && review.payload.cwdDisplay === expectedCwd;
        const option = review.decisionOptions.find(value => value.kind === (allowed ? "accept" : "decline"));
        if (!option) throw new Error("Unsupported evaluation approval presentation");
        const submissionId = `${input.trialRef.id}:${identity}`;
        const result = await execution.activeRun.submitInteraction({request: pending.request, submissionId, payload: {
          submissionId, runId: review.runId, requestId: review.id, pendingVersion: pending.request.requestVersion,
          optionId: option.id, grantedPermissions: null, reason: allowed ? "Declared isolated fixture command" : "Outside declared fixture authorization",
        }});
        await appendFile(join(directory, "approval-events.jsonl"), JSON.stringify({request: review.id, fingerprint: review.actionFingerprint,
          decision: allowed ? "accept" : "decline", result}) + "\n");
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })().catch(async error => {
    approvalFailure = error;
    await writeFile(join(directory, "approval-failure.json"), JSON.stringify({message: error.message, stack: error.stack,
      pending: execution.activeRun.getStatus().pendingInteractions}));
    await execution.activeRun.cancel({origin: "user", reasonCode: "user_requested"});
  });
  let outcome;
  try {outcome = await execution.result;} finally {ended = true; await approvals;}
  if (approvalFailure) throw approvalFailure;
  await host.service.close(); host = null;
  const captureExport = await exportExecution(prepared.rootRunId);
  await closeRecording();
  const health = inspection.recorder?.health();
  await saveObject(join(directory, "target-result.json"), {runId: prepared.rootRunId, status: outcome.runResult.status,
    cause: outcome.runResult.cause, output:outcome.runResult.finalOutput, generation: store.generation, captureExport,
    inspection: inspection.recorder ? {sourceId: inspection.recorder.source.sourceId, datasetId: inspection.recorder.manifest.datasetId,
      health} : {unavailable: true}});
  await store.close(); store = null; app.exit(0);
}
main().catch(async error => {
  await writeFile(join(directory, "target-failure.json"), JSON.stringify({message: error.message, stack: error.stack})).catch(() => {});
  console.error(error);
  if (host) await host.service.close(100).catch(() => {});
  if (inspection) await inspection.close().catch(() => {});
  if (store) await store.close().catch(() => {});
  app.exit(1);
});
