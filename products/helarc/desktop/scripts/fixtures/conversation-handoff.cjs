const {app} = require("electron");
const assert = require("node:assert/strict");
const {join} = require("node:path");
const {pathToFileURL} = require("node:url");
const {mkdir, readFile, writeFile, appendFile} = require("node:fs/promises");
const [directory, phase] = process.argv.slice(2);
app.setPath("userData", join(directory, "electron"));
app.disableHardwareAcceleration();

async function main() {
  await app.whenReady();
  const load = path => import(pathToFileURL(join(__dirname, "../../dist/main", path)).href);
  const {HelarcExecutionStore} = await load("execution-storage/HelarcExecutionStore.js");
  const {ElectronSafeStorageCredentialCipher} = await load("provider/ElectronSafeStorageCredentialCipher.js");
  const {prepareHelarcHostRun} = await load("run/HelarcHostRunComposition.js");
  const {createHelarcActivityHost} = await load("context/HelarcActivityHost.js");
  const {HelarcInspection} = await load("inspection/HelarcInspection.js");
  const {createStaticHostWorkspaceResolver, createStaticHostIdentityResolver} = await import("@agent-anything/host/context");
  const {createHelarcTask} = await import("@agent-anything/helarc/task");
  const {createDefaultHelarcInstructionSettings, createHelarcProviderProfile} = await import("@agent-anything/helarc/configuration");
  const {OllamaProvider} = await import("@agent-anything/provider-integrations/ollama");
  const workspaceRoot = join(directory, "workspace"); await mkdir(workspaceRoot, {recursive: true});
  const inspection = await HelarcInspection.create(join(directory, "inspection-settings.json"), join(directory, "inspection"));
  const store = await HelarcExecutionStore.open(join(directory, "execution"), undefined, inspection.evidenceObserver,
    inspection.fileMaterialObserver, undefined, new ElectronSafeStorageCredentialCipher(), inspection.contextMaterialObserver,
    inspection.activityObserver, inspection.contextFoundationObserver);
  const host = createHelarcActivityHost(store, {executionFlow: inspection.executionFlow});
  let sourceRunId, targetRunId, sourceCalls = 0, targetCalls = 0;
  const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value));
  const settings = {model: "handoff-fixture", baseUrl: "https://fixture.invalid", timeoutMs: 30000, think: false,
    nativeToolInteraction: {supported: true}, runtime: {contextWindowTokens: 163840},
    requestBodyTransportLimit: {maximumBytes: 16000000, source: "host_configured", revision: "1"}};
  const provider = new OllamaProvider(settings, async (_url, init) => {
    const body = JSON.parse(init.body), source = !targetRunId;
    const calls = source ? ++sourceCalls : ++targetCalls;
    assert(!body.messages.some(m => m.role === "system"), "Optional instructions must remain disabled");
    await appendFile(join(directory, `${phase}-requests.jsonl`), JSON.stringify(body) + "\n");
    let name, input;
    if (source && calls === 1) {
      name = "PowerShell";
      input = {command: "[System.IO.File]::AppendAllText('effect.txt', 'x'); Write-Output 'initial calculation: a=7 b=20'"};
    } else {
      name = "final_result";
      input = {response: source ? "Initial calculation: a=7, b=20." : "The correction is a=7, b=21; prior effects were not repeated."};
    }
    if (!source) {
      const history = JSON.stringify(body.messages);
      assert(history.includes("initial calculation: a=7 b=20"), "Tool result must survive the handoff");
      const commands = body.messages.flatMap(m => m.tool_calls ?? []).filter(call => call.function.name.startsWith("PowerShell"));
      assert.equal(commands.length, 1, "Imported effect must appear exactly once");
      assert.equal(history.split("Use 9 instead of 8 for the second b row.").length - 1, 1);
    }
    const callable = body.tools.find(t => t.function.name === name || t.function.name.startsWith(`${name}_`));
    assert(callable, `Missing callable ${name}`);
    return new Response(JSON.stringify({model: body.model, created_at: new Date().toISOString(), done: true, done_reason: "stop",
      message: {role: "assistant", content: "", tool_calls: [{function: {name: callable.function.name, arguments: input}}]},
      prompt_eval_count: 1000, eval_count: 20}), {status: 200});
  });
  const profile = createHelarcProviderProfile({id: "handoff", providerKind: "ollama", displayName: "Handoff verification", baseUrl: settings.baseUrl,
    model: settings.model, timeoutMs: settings.timeoutMs, ollamaRuntime: settings.runtime, credentialStatus: "empty_allowed", isActive: true}).profile;
  assert(profile, "Verification profile must be valid");
  const workspace = {primary: {id: "workspace", name: "workspace", rootRef: workspaceRoot, trustState: "trusted", source: "test", policyRefs: [], metadata: {}}, additional: []};
  const task = (id, prompt) => createHelarcTask({taskId: id, prompt, createdAt: "2026-11-03T00:00:00.000Z"}).task;
  const common = {provider, providerProfile: profile, sessionId: "same-conversation", inputItems: [], permissionPreset: "full_access",
    instructionSettings: createDefaultHelarcInstructionSettings(), executionStore: store, activityHost: host, inspection,
    commandOutputDirectory: join(directory, "command-output"), workspaceResolver: createStaticHostWorkspaceResolver(workspace),
    workspaceSelection: {kind: "references", primaryRef: "workspace", additionalRefs: []},
    identityResolver: createStaticHostIdentityResolver({id: "verifier", kind: "anonymous", displayName: "Verifier", metadata: {}}), identitySelection: {kind: "anonymous"}};
  if (phase === "seed") {
    const source = await prepareHelarcHostRun({...common, productRunId: "source", task: task("source", "Calculate a=7, b=12+8; record the operation once.")});
    sourceRunId = source.rootRunId;
    assert.equal((await source.start().result).runResult.status, "completed");
    assert.equal(await readFile(join(workspaceRoot, "effect.txt"), "utf8"), "x");
    await store.commitProductDelivery(sourceRunId);
    const target = await prepareHelarcHostRun({...common, productRunId: "target", conversationSourceRunId: sourceRunId,
      task: task("target", "Use 9 instead of 8 for the second b row.")});
    targetRunId = target.rootRunId;
    const admission = await store.readProductRun(targetRunId);
    await save("boundary.json", {sourceRunId, targetRunId, sourceHead: await store.readLatestRun(sourceRunId),
      handoff: admission.conversationHandoff, generation: store.generation});
    const commit = store.commitRunTree.bind(store);
    store.commitRunTree = async value => {
      await commit(value);
      assert.equal(targetCalls, 0);
      // Lose the acknowledgement after the target Run's first durable admission.
      await inspection.close();
      app.exit(73); await new Promise(() => {});
    };
    await target.start().result;
    throw new Error("Expected interruption was not reached");
  }
  const boundary = JSON.parse(await readFile(join(directory, "boundary.json"), "utf8"));
  ({sourceRunId, targetRunId} = boundary);
  assert(store.generation > boundary.generation);
  const admission = await store.readProductRun(targetRunId);
  assert.deepEqual(admission.conversationHandoff, boundary.handoff);
  const original = await store.readRunTree(targetRunId);
  assert.deepEqual(original.members[0].admission.modelInteractionSeed, boundary.handoff.seed);
  if (phase === "resume") {
    // Source reassembly must not be consulted when resuming an admitted target.
    store.prepareConversationHandoff = async () => {throw new Error("Recovery attempted to rebuild history");};
    const restored = await prepareHelarcHostRun({...common, productRunId: admission.productRunId, task: admission.task,
      instructionSettings: admission.instructionSettings, recoveryAdmission: admission});
    const outcome = await (await restored.recover()).result;
    await save("resume-outcome.json", outcome.runResult);
    assert.equal(outcome.runResult.status, "completed", JSON.stringify(outcome.runResult.cause));
    assert.equal(targetCalls, 1); assert.equal(sourceCalls, 0);
    for (const ref of boundary.handoff.materialRefs) {
      if (ref.id.startsWith("custody:")) {
        const recipient={runId:targetRunId,recipient:admission.conversationHandoff.recipientAgent.id,purpose:"helarc.code-agent.turn"};
        await store.materialCustody.command({kind:"resolve_reference",reference:ref,recipient});
        await assert.rejects(store.materialCustody.command({kind:"resolve_reference",reference:ref,recipient:{...recipient,runId:"unrelated"}}));
      } else {
        await store.contextMaterials.validate(targetRunId, [ref]);
        await assert.rejects(store.contextMaterials.validate("unrelated", [ref]));
      }
    }
  } else {
    assert.equal(phase, "verify");
    assert.equal(original.members[0].head.state.status, "completed");
    const next = await store.prepareConversationHandoff(targetRunId, admission.sessionId);
    assert.equal(next.seed.presentations.filter(p => JSON.stringify(p).includes("Host-reported prior execution outcome")).length, 0);
    assert.equal(sourceCalls + targetCalls, 0);
  }
  assert.deepEqual(await store.readLatestRun(sourceRunId), boundary.sourceHead);
  assert.equal(await readFile(join(workspaceRoot, "effect.txt"), "utf8"), "x");
  await host.service.close(); await inspection.close();
  const health = inspection.recorder.health();
  for (const key of ["dropped", "rejected", "unpersisted", "unconfirmed"]) assert.equal(health[key], 0);
  if (phase === "resume") {
    const {InspectionQueryService} = await import("@agent-anything/inspection/query");
    const query = new InspectionQueryService(join(directory, "inspection"));
    const selection = (await query.query({kind: "get_snapshot", sourceId: inspection.recorder.source.sourceId, datasetId: inspection.recorder.manifest.datasetId})).selection;
    let after, records = [];
    do {
      const page = await query.query({...selection, kind: "list_records", limit: 500, ...(after ? {after} : {})});
      records.push(...page.records); after = page.next;
    } while (after);
    assert(records.some(r => r.payload.kind === "event" && r.payload.name === "conversation.handoff.admitted"));
    await query.close();
    await save("resume.json", {electron: process.versions.electron, workerGeneration: store.generation, sourceRunId, targetRunId,
      effects: 1, targetCalls, originalSeedRestored: true, originalSourceUnchanged: true, inspectorRecords: records.length, health});
  }
  await store.close();
  app.exit(0);
}
main().catch(error => {console.error(error); app.exit(1);});
