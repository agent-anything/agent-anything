const {app, safeStorage} = require("electron");
const assert = require("node:assert/strict");
const {mkdir, readFile, writeFile} = require("node:fs/promises");
const {join} = require("node:path");
const {pathToFileURL} = require("node:url");
const directory = process.argv[2];
app.setPath("userData", join(directory, "electron-user-data"));
app.disableHardwareAcceleration();

async function main() {
  await app.whenReady();
  assert(safeStorage.isEncryptionAvailable());
  const load = path => import(pathToFileURL(join(__dirname, "../../dist/main", path)).href);
  const {HelarcExecutionStore} = await load("execution-storage/HelarcExecutionStore.js");
  const {ElectronSafeStorageCredentialCipher} = await load("provider/ElectronSafeStorageCredentialCipher.js");
  const {prepareHelarcHostRun} = await load("run/HelarcHostRunComposition.js");
  const {createHelarcActivityHost}=await load("context/HelarcActivityHost.js");
  const {createStaticHostIdentityResolver, createStaticHostWorkspaceResolver} = await import("@agent-anything/host/context");
  const {createHelarcTask} = await import("@agent-anything/helarc/task");
  const {createHelarcProviderProfile, createDefaultHelarcInstructionSettings} = await import("@agent-anything/helarc/configuration");
  const {createFakeProviderContext} = await import("@agent-anything/test-support");
  const {OpenAICompatibleProvider}=await import("@agent-anything/provider-integrations/openai-compatible");
  const {createModelCallRef, createModelTurnId, snapshotModelCallableRequest, snapshotProviderResponse} = await import("@agent-anything/model-interaction");
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot);
  const timings = {}, observed = [];
  const diagnostics = {record() {}, performance(event) {
    if (event.kind !== "finished") return;
    const key = `${event.stage}:${event.context.command ?? event.context.commandKind ?? ""}`;
    const entry = timings[key] ??= {count: 0, totalMs: 0, maxMs: 0, counters: {}};
    entry.count++; entry.totalMs += event.durationMs; entry.maxMs = Math.max(entry.maxMs, event.durationMs);
    for (const [name, value] of Object.entries(event.counters ?? {})) entry.counters[name] = (entry.counters[name] ?? 0) + value;
  }};
  const started = performance.now();
  let store = await HelarcExecutionStore.open(join(directory, "execution"), undefined,
    {observe(event) {observed.push(event);}}, undefined, diagnostics, new ElectronSafeStorageCredentialCipher());
  let active, calls = 0, original;
  const activityHost=createHelarcActivityHost(store,{diagnostics});
  try {
    const providerId = "openai-compatible.chat-completions";
    const context = createFakeProviderContext(providerId, "host-run-test-model");
    const encoder=new OpenAICompatibleProvider({baseUrl:"https://provider.local/v1",apiKey:"",model:context.modelContext.target.model,timeoutMs:30000,nativeToolInteraction:{supported:true},requestBodyTransportLimit:context.requestBodyTransportLimit});
    const provider = {...context, encodeInput:(request,mode)=>encoder.encodeInput(request,mode),
      verifyEncodedInput:(request,encoded)=>encoder.verifyEncodedInput(request,encoded),descriptor: {id: providerId, name: "Host persistence verification", metadata: {},
      requestRetryScheduler: {kind: "harness"}, capabilities: {
        nativeToolInteraction: {supported: true, callableDefinitions: true, modelCalls: true, resultMessages: true, multipleCalls: true, callCorrelation: "provider_supplied"},
        structuredGeneration: {supported: true}, streaming: {supported: false},
        modelContext: {capacity: context.modelContext.capacity, requestedOutput: context.modelContext.requestedOutput, inputPreservation: context.modelContext.inputPreservation},
        continuation: {supported: false}, compaction: {supported: false},
        usageMetering: {inputTokens: "unavailable", outputTokens: "unavailable", costUnits: "unavailable"}}},
      async send(request,_interruption,options) {
        assert(options?.encodedInput,"Original prepared input is required");
        encoder.verifyEncodedInput(request,options.encodedInput);
        calls++;
        assert.equal(request.interaction.kind, "native_tool_turn");
        assert.equal(request.instructions.content.length, 0);
        const latest = request.messages.flatMap(message => message.role === "tool" ? message.content.map(block => block.result) : []).at(-1);
        let tool, input;
        if (calls === 1) {tool = "Write"; input = {file_path: "target.txt", content: "before"};}
        else if (calls === 2) {
          original = latest.content.references.find(ref => ref.kind === "effect"); assert(original);
          tool = "Write"; input = {file_path: "target.txt", content: "must not be written", compensation_of: {targets: [{...original, id: "unknown"}]}};
        } else if (calls === 3) {
          assert.equal(latest.settlement, "invalid"); assert.equal(latest.content.failure.code, "execution_reference_unavailable");
          tool = "Edit"; input = {file_path: "target.txt", old_string: "before", new_string: "after", compensation_of: {targets: [original], explanation: "Replace the original content"}};
        } else {
          assert.equal(calls, 4); tool = "final_result"; input = {response: "The explicitly associated edit settled."};
        }
        const name = tool === "final_result" ? tool : request.interaction.callables.find(call => call.name.startsWith(`${tool}_`))?.name;
        assert(name);
        const responseId = `${providerId}:response:${calls}`;
        const turnId = createModelTurnId({providerId, requestId: request.requestId, responseId});
        const call = snapshotModelCallableRequest({modelCallRef: createModelCallRef({providerRequestId: request.requestId,
          controllerRequestId: request.correlation.controllerRequestId, turnId, contentBlockOrdinal: 0, branchId: request.correlation.branchId}),
          providerCallRef: {providerId, id: `${responseId}:call:0`}, name, input, ordinal: 0});
        return {kind: "succeeded", response: snapshotProviderResponse({kind: "native_tool_turn", turn: {turnId,
          assistant: {role: "assistant", content: [{kind: "model_tool_call", call}]}, finish: {kind: "normal"}, usage: null,
          responseRef: {providerId, requestId: request.requestId, responseId}}, continuation: null, metadata: {}})};
      }};
    const task = createHelarcTask({taskId: "helarc-task-1", prompt: "Inspect the workspace.", createdAt: "2026-06-28T00:00:00.000Z"});
    const profile = createHelarcProviderProfile({id: "test-provider", providerKind: "openai-compatible", displayName: "Test Provider",
      baseUrl: "https://provider.local/v1", model: context.modelContext.target.model, timeoutMs: 30000, credentialStatus: "empty_allowed", isActive: true});
    assert(task.ok && profile.ok);
    const prepared = await prepareHelarcHostRun({task: task.task, provider, executionStore: store,activityHost,
      productRunId: task.task.id, sessionId: task.task.id, inputItems: [], permissionPreset: "full_access", providerProfile: profile.profile,
      instructionSettings: createDefaultHelarcInstructionSettings(), commandOutputDirectory: join(directory, "command-output"),
      workspaceResolver: createStaticHostWorkspaceResolver({primary: {id: "workspace", name: "workspace", rootRef: workspaceRoot,
        trustState: "trusted", source: "test", policyRefs: [], metadata: {}}, additional: []}),
      workspaceSelection: {kind: "references", primaryRef: "workspace", additionalRefs: []},
      identityResolver: createStaticHostIdentityResolver({id: "test-anonymous", kind: "anonymous", displayName: "Test user", metadata: {}}),
      identitySelection: {kind: "anonymous"}});
    active = prepared.start();
    const result = await active.result;
    active = null;
    assert.equal(result.runResult.status, "completed", JSON.stringify(result.product.output.safeErrors));
    const operations = result.runResult.items.flatMap(item => item.payload.kind === "observation" && item.payload.observation.payload.kind === "operation"
      ? [item.payload.observation.payload.result] : []);
    assert.deepEqual(operations.map(operation => operation.status), ["succeeded", "invalid", "succeeded"]);
    assert.equal(result.product.actions.length, 2);
    assert.equal(await readFile(join(workspaceRoot, "target.txt"), "utf8"), "after");
    const invocation = operations.at(-1).ref.invocation;
    const association = await store.readCompensationAssociation(invocation.id);
    assert.deepEqual(association.targets[0].requested, original);
    assert.equal(association.targets[0].execution.id, operations[0].ref.id);
    const evidence = await store.readExecutionEvidence(original);
    assert.equal(evidence.effects[0].value.operation, "created");
    assert.equal(evidence.effects[0].value.before, null);
    assert.equal(observed.filter(event => event.kind === "compensation_intent_committed").length, 1);
    const physical = await store.readRunTree(prepared.rootRunId);
    const bindings = physical.members.flatMap(member => member.head.control.operations.map(operation => operation.binding));
    assert(bindings.some(binding => binding.compensation?.id === association.id));
    assert(bindings.every(binding => !Object.hasOwn(binding.request, "compensation_of")));
    await activityHost.service.close();
    await store.close();
    store = await HelarcExecutionStore.open(join(directory, "execution"), undefined, undefined, undefined, diagnostics, new ElectronSafeStorageCredentialCipher());
    assert.deepEqual(await store.readCompensationAssociation(invocation.id), association);
    assert.equal(calls, 4);
    await store.close();
    const report = {electron: process.versions.electron, elapsedMs: performance.now() - started, calls, actions: result.product.actions.length, timings};
    await writeFile(join(directory, "verification.json"), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({...report, timings: Object.fromEntries(Object.entries(timings).filter(([key]) => key.includes("commit_run_tree")))}) + "\n");
  } finally {
    if (active) {
      await active.activeRun.cancel({origin: "host", reasonCode: "host_requested", reason: "Persistence verification ended."}).catch(() => {});
      await active.result.catch(() => {});
    }
    await activityHost.service.close();
    await store.close();
  }
}
main().then(() => app.exit(0), error => {process.stderr.write(`${error.stack}\n`); app.exit(1);});
