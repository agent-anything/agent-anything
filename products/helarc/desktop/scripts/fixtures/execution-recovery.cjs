const {app, safeStorage} = require("electron");
const assert = require("node:assert/strict");
const {join} = require("node:path");
const {pathToFileURL} = require("node:url");
const {mkdir, readFile, writeFile, appendFile} = require("node:fs/promises");
const {writeFileSync} = require("node:fs");
const {inspect} = require("node:util");
const [directory, scenario, stage] = process.argv.slice(2);
const endingRecovery = scenario.startsWith("ending_");
const interactionRecovery = scenario.startsWith("interaction_");
const materialRecovery = scenario.startsWith("material_");
const contextRecovery = scenario.startsWith("context_");
const capacityRecovery = scenario === "provider_capacity_saved";
const providerRecovery = scenario === "provider_failure_saved" || capacityRecovery;
const semanticRecovery = scenario.startsWith("semantic_");
const stagedSemantic = ["semantic_leaf", "semantic_merge"].includes(scenario);
const backgroundSemantic = scenario.startsWith("semantic_background");
const backgroundAdopt = scenario === "semantic_background_adopt";
let backgroundReady;
const backgroundReturned = new Promise(resolve => {backgroundReady = resolve;});
async function waitForBackground(signal) {
  signal.throwIfAborted();
  let timer, abort;
  try {
    await Promise.race([backgroundReturned, new Promise((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, {once: true});
      timer = setTimeout(() => reject(new Error("Background generation did not reach its durable response boundary")), 30_000);
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}
app.setPath("userData", join(directory, "electron-user-data"));
app.disableHardwareAcceleration();
globalThis.fetch = async () => {throw new Error("This recovery verification must not call a network Provider");};

async function main() {
  await app.whenReady();
  assert.equal(safeStorage.isEncryptionAvailable(), true);
  const load = path => import(pathToFileURL(join(__dirname, "../../dist/main", path)).href);
  const {HelarcExecutionStore} = await load("execution-storage/HelarcExecutionStore.js");
  const {ElectronSafeStorageCredentialCipher} = await load("provider/ElectronSafeStorageCredentialCipher.js");
  const {prepareHelarcHostRun} = await load("run/HelarcHostRunComposition.js");
  const {createStaticHostIdentityResolver, createStaticHostWorkspaceResolver} = await import("@agent-anything/host/context");
  const {createHelarcTask} = await import("@agent-anything/helarc/task");
  const {createHelarcProviderProfile} = await import("@agent-anything/helarc/configuration");
  const {createFakeProviderContext} = await import("@agent-anything/test-support");
  const {OpenAICompatibleProvider} = await import("@agent-anything/provider-integrations/openai-compatible");
  const {createModelCallRef, createModelTurnId, snapshotModelCallableRequest, snapshotProviderResponse, createUnknownModelInputMeasurement} = await import("@agent-anything/model-interaction");
  const {snapshotModelInputPlanning, CONTEXT_ASSESSMENT_CRITERIA} = await import("@agent-anything/model-interaction/context");
  const {selectModelWorkingView, modelInputValueDigest} = await import("@agent-anything/model-interaction/input");
  const workspaceRoot = join(directory, "workspace"), marker = join(workspaceRoot, "executions.txt");
  await mkdir(workspaceRoot, {recursive: true});
  const {HelarcExecutionDiagnostics} = await import("../../dist/main/diagnostics/HelarcExecutionDiagnostics.js");
  const diagnostics = new HelarcExecutionDiagnostics(join(directory, `diagnostics-${stage}`, "execution-diagnostics.json"));
  const inspectionRoot = join(directory, "inspection");
  const {HelarcInspection} = await load("inspection/HelarcInspection.js");
  const inspection = process.env.HELARC_RECOVERY_INSPECTION === "1" && stage === "resume"
    ? await HelarcInspection.create(join(directory, "inspection-settings.json"), inspectionRoot) : null;
  if (inspection) assert.equal(inspection.snapshot().health.available, true);
  const store = await HelarcExecutionStore.open(join(directory, "execution"), undefined, inspection?.evidenceObserver,
    inspection?.fileMaterialObserver, diagnostics, new ElectronSafeStorageCredentialCipher(), inspection?.contextMaterialObserver);
  const seedFile = join(directory, "seed.json");
  let rootRunId, calls = 0, seedExecution, materialRef, preparationId;
  const requests = [];
  const runCalls = new Map();
  const providerId = "openai-compatible.chat-completions";
  const context = createFakeProviderContext(providerId, "deterministic-verification-model");
  const semanticCapacity = {supported: true, unit: "tokens", maximum: 200000, semantics: "input_and_output",
    source: "host_configured", providerId, model: context.modelContext.target.model, revision: "synthetic-test.v1"};
  const semanticOutput = {unit: "tokens", maximum: null, source: "unspecified", revision: "synthetic-test.v1"};
  let encodedRequest = null;
  const wireAdapter = new OpenAICompatibleProvider({baseUrl: "https://encoded.test/v1", apiKey: "", model: "deterministic-verification-model",
    timeoutMs: 30000, nativeToolInteraction: {supported: true}, requestBodyTransportLimit: {
      maximumBytes: 16 * 1024 * 1024, source: "host_configured", revision: "verification-v1"}}, async (_url, init) => {
    encodedRequest = JSON.parse(init.body);
    return new Response(JSON.stringify({error: capacityRecovery ? {message: "The input exceeds the context window", code: "context_length_exceeded"}
      : {message: "No network: serialization verification only"}}), {status: capacityRecovery ? 400 : 503});
  });
  const provider = {modelContext: {...context.modelContext, accounting: {...wireAdapter.modelContext.accounting,
      basis: {fixture: "deterministic-usage.v1"}, inputUsage: "complete", outputUsage: "complete", limitations: ["synthetic_usage_not_endpoint_qualification"],
      ...(semanticRecovery ? {defaultGenerationRoom: backgroundSemantic ? 169500 : stagedSemantic ? 110000 : 173000} : {})},
      ...(semanticRecovery ? {capacity: semanticCapacity, requestedOutput: semanticOutput} : {}),
      measure(composition, measuredAt) {return semanticRecovery ? {status: "measured", amount: JSON.stringify(composition.messages).length,
        estimator: {id: "synthetic-character-cost", revision: "1", unit: "tokens", accuracy: "exact"}, uncertainty: {kind: "none"},
        measuredAt, measuredCompositionId: composition.id} : createUnknownModelInputMeasurement({compositionId: composition.id, measuredAt, reason: "unsupported"});}},
    requestBodyTransportLimit: context.requestBodyTransportLimit,
    descriptor: {id: providerId, name: "Recovery verification", metadata: {}, capabilities: {
      nativeToolInteraction: {supported: true, callableDefinitions: true, modelCalls: true, resultMessages: true, multipleCalls: true, callCorrelation: "provider_supplied"},
      structuredGeneration: {supported: true}, streaming: {supported: false},
      modelContext: {capacity: semanticRecovery ? semanticCapacity : context.modelContext.capacity,
        requestedOutput: semanticRecovery ? semanticOutput : context.modelContext.requestedOutput, inputPreservation: context.modelContext.inputPreservation},
      continuation: {supported: false}, compaction: {supported: false}, usageMetering: {inputTokens: "unavailable", outputTokens: "unavailable", costUnits: "unavailable"}},
      requestRetryScheduler: {kind: "harness"}},
    async send(request, interruption) {
      requests.push(request); calls++;
      await appendFile(join(directory, `${stage}-provider-requests.jsonl`), JSON.stringify(request) + "\n");
      assert.equal(request.composition.workingView.recipientRunId, request.metadata.runId);
      assert.equal(request.composition.workingView.boundary, "request");
      assert.deepEqual(selectModelWorkingView(request.composition.workingView, request.composition.sections), request.composition.sections);
      assert(request.composition.workingView.nativeGroups.every(group => group.status === "settled"));
      const planning = snapshotModelInputPlanning(request.modelContext.assessment.planning);
      assert.equal(planning.requestId, request.requestId);
      assert.equal(planning.runId, request.metadata.runId);
      if (semanticRecovery) assert.equal(planning.measurement.status, "measured");
      else if (planning.anchor) {
        assert.equal(planning.anchor.runId, request.metadata.runId, "Never borrow another Run's anchor");
        assert.equal(planning.measurement.estimator.accuracy, "estimated");
      } else assert.equal(planning.measurement.status, "unknown");
      encodedRequest = null;
      const wire = await wireAdapter.send(request, interruption);
      assert(encodedRequest, `Actual Provider encoder did not produce a request: ${JSON.stringify(wire)}`);
      assert.equal(encodedRequest.workingView, undefined, "Selection metadata must not become a wire instruction");
      if (request.composition.lineage.auxiliary) {
        assert(semanticRecovery, "Ordinary recovery fixtures must not need semantic work");
        assert.equal(request.composition.lineage.agent, null);
        assert.equal(encodedRequest.tools, undefined, "Auxiliary work has no executable catalog");
        assert.equal(encodedRequest.messages[0].role, "system");
        assert.equal(encodedRequest.messages[1].role, "user");
        const payload = JSON.parse(request.messages[0].content[0].text);
        const ids = payload.replacementSources.map(section => section.id);
        const output = request.purpose === "context_generation" ? {entries: [{text:
          "The user requested one marker without duplication on recovery. The assistant planned to append it and called the shell in the supplied workspace. The shell reported completed once. The plan remained in progress; no second command ran.",
          sources: ids}], limitations: [], omittedDetails: ["Repetitive report padding"]} : {
          findings: CONTEXT_ASSESSMENT_CRITERIA.map(criterion => ({criterion, verdict: "adequate", reason: "Fixture compares source, preserved result and active background.", sources: ids})),
          inheritedDefects: [], introducedLoss: [], limitations: []};
        return {kind: "succeeded", response: snapshotProviderResponse({kind: "structured_generation", responseId: `auxiliary:${stage}:${calls}`,
          output, usage: {inputTokens: 101, outputTokens: 17, totalTokens: 118, costUnits: null, metadata: {}}, continuation: null, metadata: {}})};
      }
      const expectedRoles = request.messages.flatMap(message => message.role === "tool" ? message.content.map(() => "tool") : [message.role]);
      assert.deepEqual(encodedRequest.messages.map(message => message.role), expectedRoles);
      let wireIndex = 0;
      for (const message of request.messages) {
        if (message.role === "tool") for (const {result} of message.content) {
          const actual = encodedRequest.messages[wireIndex++];
          assert.equal(actual.tool_call_id, result.providerCallRef.id);
          assert.deepEqual(JSON.parse(actual.content).content, result.content);
        } else {
          const actual = encodedRequest.messages[wireIndex++];
          assert.equal(actual.content ?? "", message.content.filter(block => block.kind === "text").map(block => block.text).join("\n\n"));
          if (message.role === "assistant") assert.deepEqual((actual.tool_calls ?? []).map(call => call.id),
            message.content.filter(block => block.kind === "model_tool_call").map(block => block.call.providerCallRef.id));
        }
      }
      const runCall = (runCalls.get(request.metadata.runId) ?? 0) + 1;
      runCalls.set(request.metadata.runId, runCall);
      if (providerRecovery && stage === "seed" && runCall === 2) {
        assert.equal(wire.kind, "failed");
        assert.equal(await readFile(marker, "utf8"), "x");
        return {...wire, failure: {...wire.failure, retryAfterMs: undefined, requestId: undefined}};
      }
      if (backgroundSemantic && stage === "seed" && runCall === 4) {
        // Leave an ordinary request pending while the independent producer commits.
        assert(planning.measurement.amount <= planning.workingTarget &&
          planning.measurement.amount + planning.growthAllowance > planning.workingTarget,
          `Background fixture needs fit-now/pressure-next: ${JSON.stringify({amount: planning.measurement.amount, target: planning.workingTarget, growth: planning.growthAllowance})}`);
        if (backgroundAdopt) await waitForBackground(interruption.signal);
        else await new Promise((_resolve, reject) => interruption.signal.addEventListener("abort", () => reject(interruption.signal.reason), {once: true}));
      }
      const child = request.metadata.runId !== rootRunId;
      let requested;
      const originalCommand = () => {
        const command = process.platform === "win32"
          ? "if ($env:HELARC_NEW_HOST_ONLY) { throw 'Ambient environment leaked' }; [System.IO.File]::AppendAllText('executions.txt', 'x'); Write-Output 'completed once'"
          : "test -z \"$HELARC_NEW_HOST_ONLY\" || exit 9; printf x >> executions.txt; printf 'completed once\\n'";
        return [{name: "update_plan", input: {plan: [{step: "Append the execution marker", status: "in_progress"}]}},
          {name: process.platform === "win32" ? "PowerShell" : "Bash", input: {command, timeout_ms: 10000, wait_ms: 10000}}];
      };
      if (semanticRecovery) {
        requested = stage === "seed" && runCall === 1 ? originalCommand() : stage === "seed" && runCall <= (backgroundAdopt ? 4 : stagedSemantic || backgroundSemantic ? 3 : 2) ?
          [{name: "update_plan", input: {plan: [{step: "Append the execution marker", status: "in_progress"}]}}] :
          [{name: "final_result", input: {response: "Root completed once.", plan: [{step: "Append the execution marker", status: "completed"}]}}];
      } else if (materialRecovery) {
        const results = request.messages.flatMap(message => message.content).filter(block => block.kind === "model_tool_result").map(block => block.result.content.output);
        if (stage === "seed") {
          if (!child && runCall === 1) requested = originalCommand();
          else if (!child && runCall === 2) requested = [{name: "ContextMaterialSearch", input: {query: "Append one marker", in: "content"}}];
          else if (!child && runCall === 3) {
            materialRef = results.find(output => output?.matches?.length)?.matches[0].description.reference;
            assert(materialRef, "The actual search result must disclose the retained assignment");
            requested = [{name: "ContextMaterialRead", input: {reference: materialRef}}];
          } else if (!child) {
            assert(results.some(output => output?.text?.includes("Append one marker")), "Read body must reach the first consuming request");
            requested = [{name: "Agent", input: {prompt: "Inspect the explicitly transferred assignment and return its material reference. Do not execute a command.", material_refs: [materialRef]}}];
          } else {
            assert(JSON.stringify(request.messages).includes(materialRef.id), "Child opening must disclose the exact grant");
            await assert.rejects(store.contextMaterials.read("unrelated-sibling", {reference: materialRef}, new AbortController().signal, "forbidden-read"), /not disclosed/);
            requested = [{name: "update_plan", input: {plan: [{step: "Read transferred material", status: "in_progress"}]}}, {name: "ContextMaterialRead", input: {reference: materialRef}}];
          }
        } else if (child) {
          assert(results.some(output => output?.text?.includes("Append one marker")), "Recovered Child read must deliver real retained bytes");
          requested = [{name: "final_result", input: {response: "Retained material read without another command.", material_refs: [materialRef], plan: [{step: "Read transferred material", status: "completed"}]}}];
        } else if (runCall === 1) {
          assert(results.some(output => output?.material_refs?.some(ref => ref.id === materialRef.id)), "Parent must receive the explicit Child attachment");
          requested = [{name: "ContextMaterialRead", input: {reference: materialRef}}];
        } else requested = [{name: "final_result", input: {response: "Root completed once.", plan: [{step: "Append the execution marker", status: "completed"}]}}];
      } else if (contextRecovery && stage === "seed" && calls > 1) {
        requested = [{name: "final_result", input: {response: "Root completed once.", plan: [{step: "Append the execution marker", status: "completed"}]}}];
      } else if (scenario === "opening_prepared" && stage === "resume" && runCall === 1) {
        requested = originalCommand();
      } else if (scenario === "continued_child" && stage === "seed") {
        if (!child && runCall === 1) requested = [
          {name: "update_plan", input: {plan: [{step: "Append the execution marker", status: "in_progress"}]}},
          {name: "Agent", input: {prompt: "Append the execution marker exactly once, then report.", description: "Original child assignment"}},
        ];
        else if (!child && runCall === 2) requested = [{name: "ContextMaterialSearch", input: {query: "Append one marker", in: "content"}}];
        else if (!child) {
          const results = request.messages.flatMap(message => message.content).filter(block => block.kind === "model_tool_result").map(block => block.result.content.output);
          materialRef = results.find(output => output?.matches?.length)?.matches[0].description.reference;
          assert(materialRef, "Continuation must receive a newly discovered Parent material");
          const agentId = request.messages.flatMap(message => message.content).find(block =>
            block.kind === "model_tool_result" && block.result.content.output?.agent_id)?.result.content.output.agent_id;
          assert(agentId, "Continuation must use the actual delivered child reference");
          requested = [{name: "SendMessage", input: {agent_id: agentId, prompt: "Explain the retained finding. Read the newly attached material. Do not execute the command again.", material_refs: [materialRef]}}];
        } else if (runCall === 1) requested = originalCommand();
        else requested = [{name: "final_result", input: {response: "Child completed once.", plan: [{step: "Append the execution marker", status: "completed"}]}}];
      } else if (scenario === "continued_child" && stage === "resume" && child && runCall === 1) {
        assert(JSON.stringify(request.messages).includes(materialRef.id), "Recovered continuation opening must disclose its new reference");
        requested = [{name: "ContextMaterialRead", input: {reference: materialRef}}];
      } else if (scenario === "continued_child" && stage === "resume" && child) {
        const results = request.messages.flatMap(message => message.content).filter(block => block.kind === "model_tool_result").map(block => block.result.content.output);
        assert(results.some(output => output?.text?.includes("Append one marker")), "Continuation must read real retained bytes after restart");
        requested = [{name: "final_result", input: {response: "Child completed once.", plan: [{step: "Append the execution marker", status: "completed"}]}}];
      } else if (interactionRecovery && stage === "seed" && calls === 2) {
        if (scenario === "interaction_steering") {
          const receipt = await seedExecution.activeRun.steer({commandId: "steer-recovery",
            expectedRunRevision: seedExecution.activeRun.getProjection().runRevision,
            instruction: "Use the retained command result; do not execute the command again.",
            attribution: {origin: "user", actorId: "verification"}});
          assert.equal(receipt.status, "accepted_for_application");
        }
        requested = scenario === "interaction_call_feedback"
          ? [{name: "Write", input: {path: "missing-parent/file.txt", content: "must not be created"}},
            {name: "final_result", input: {response: "Candidate before a failed write.",
              plan: [{step: "Append the execution marker", status: "completed"}]}}]
          : [];
      } else if (scenario === "interaction_accepted" && stage === "seed" && calls === 3) {
        requested = [{name: "update_plan", input: {plan: [{step: "Append the execution marker", status: "in_progress"}]}}];
      } else if (endingRecovery && (stage === "seed" && calls > 1 || stage !== "seed" && scenario === "ending_exhausted")) {
        requested = [];
      } else if (stage !== "seed") {
        // Only a genuine final response is supplied after restart: never recreate accepted work.
        requested = [{name: "final_result", input: {response: child ? "Child completed once." : "Root completed once.",
          plan: [{step: "Append the execution marker", status: "completed"}]}}];
      } else if (scenario === "child" && !child) {
        requested = [{name: "update_plan", input: {plan: [{step: "Append the execution marker", status: "in_progress"}]}},
          {name: "Agent", input: {prompt: "Append the execution marker exactly once, then report.", description: "Recovery verification child"}}];
      } else {
        requested = originalCommand();
      }
      const responseId = `verification:${stage}:${calls}`, turnId = createModelTurnId({providerId: provider.descriptor.id, requestId: request.requestId, responseId});
      const padding = semanticRecovery && stage === "seed" && (runCall <= (stagedSemantic ? 3 : 1) || backgroundAdopt && runCall === 4);
      const content = requested.map((call, index) => {const ordinal = index + (padding ? 1 : 0); return {kind: "model_tool_call", call: snapshotModelCallableRequest({
        modelCallRef: createModelCallRef({providerRequestId: request.requestId, controllerRequestId: request.correlation.controllerRequestId, turnId,
          contentBlockOrdinal: ordinal, branchId: request.correlation.branchId}),
        providerCallRef: {providerId: provider.descriptor.id, id: `${responseId}:${ordinal}`}, ordinal,
        name: ["final_result", "update_plan"].includes(call.name) ? call.name : request.interaction.callables.find(value => value.name.startsWith(`${call.name}_`)).name,
        input: call.input})};});
      if (requested.length === 0) content.push({kind: "text", text: `Ordinary report without an ending signal (${stage}:${calls}).`});
      // The newest exchange stays exact; its larger body requires relief across two older closed exchanges.
      if (padding) content.unshift({kind: "text", text: "Report padding, not a new operation. ".repeat(backgroundAdopt && runCall === 4 ? 150 : stagedSemantic ? runCall === 3 ? 1600 : 1000 : 420)});
      return {kind: "succeeded", response: snapshotProviderResponse({kind: "native_tool_turn", turn: {turnId, assistant: {role: "assistant", content},
        finish: {kind: "normal"}, usage: {inputTokens: backgroundSemantic ? JSON.stringify(request.messages).length : 1000 + runCall * 100, outputTokens: 12,
          totalTokens: (backgroundSemantic ? JSON.stringify(request.messages).length : 1000 + runCall * 100) + 12, costUnits: null, metadata: {}},
        responseRef: {providerId: provider.descriptor.id, requestId: request.requestId, responseId}}, continuation: null, metadata: {}})};
    }};
  const task = createHelarcTask({taskId: "recovery-task", prompt: "Append one marker, without duplicating it on recovery.", createdAt: "2026-10-19T00:00:00.000Z"}).task;
  const workspace = {primary: {id: "workspace", name: "workspace", rootRef: workspaceRoot, trustState: "trusted", source: "test", policyRefs: [], metadata: {}}, additional: []};
  const identity = {id: "test-anonymous", kind: "anonymous", displayName: "Test user", metadata: {}};
  const profile = createHelarcProviderProfile({id: "test-provider", providerKind: "openai-compatible", displayName: "Test Provider", baseUrl: "https://provider.local/v1",
    model: context.modelContext.target.model, timeoutMs: 30000, credentialStatus: "empty_allowed", isActive: true}).profile;
  const common = {provider, task, sessionId: "test-session", productRunId: "test-product-run", inputItems: [],
    ...(inspection ? {inspection} : {}),
    permissionPreset: scenario.startsWith("approval") ? "ask_for_approval" : "full_access", providerProfile: profile,
    executionStore: store, commandOutputDirectory: join(directory, "command-output"),
    workspaceResolver: createStaticHostWorkspaceResolver(workspace), workspaceSelection: {kind: "references", primaryRef: "workspace", additionalRefs: []},
    identityResolver: createStaticHostIdentityResolver(identity), identitySelection: {kind: "anonymous"}};
  async function interrupt(extra = {}) {
    const tree = await store.readRunTree(rootRunId);
    writeFileSync(seedFile, JSON.stringify({rootRunId, generation: store.generation, calls, ...extra,
      members: tree.members.map(member => ({id: member.head.state.run.id, items: member.head.state.items.map(item => item.ref.id),
        counters: member.head.state.counters, plan: member.head.state.plan}))}));
    // Deliberate abrupt process termination, without a store close or Run cleanup.
    app.exit(73);
    await new Promise(() => {});
  }
  if (stage === "seed") {
    let submissionStarted = false;
    const prepared = await prepareHelarcHostRun(common); rootRunId = prepared.rootRunId;
    assert.equal((await store.registerRecording({sourceId:"recovery-test",datasetId:"seed",runId:rootRunId})).previous,null);
    if (contextRecovery || semanticRecovery) {
      const open = store.contextPreparations.open;
      store.contextPreparations.open = async intent => {
        const head = await open(intent);
        if (calls === 1 && intent.runId === rootRunId) {
          preparationId = intent.id;
          if (scenario === "context_intent") await interrupt({preparationId});
        }
        return head;
      };
      const write = store.contextPreparations.write;
      store.contextPreparations.write = async (id, stageName, value) => {
        await write(id, stageName, value);
        if (backgroundAdopt && stageName === "generation-response") backgroundReady();
        if (id === preparationId && stageName === "candidate" && scenario === "context_candidate") await interrupt({preparationId});
        if (semanticRecovery && ((["semantic_generated", "semantic_background"].includes(scenario) && stageName === "generation-response") ||
            (["semantic_assessed", "semantic_background_adopt"].includes(scenario) && stageName === "assessment-response") ||
            (scenario === "semantic_candidate" && stageName === "candidate" && value.value.accounts?.length))) {
          await interrupt({semanticPreparationId: id, savedStage: stageName, savedValue: value});
        }
        if (scenario === "semantic_leaf" && stageName === "outcome" && value.value?.accounts?.[0]?.derivation.assessmentLevel === "internal_node") {
          await interrupt({semanticPreparationId: id, savedStage: stageName, savedValue: value});
        }
        if (scenario === "semantic_merge" && stageName === "generation-response") {
          const request = (await store.contextPreparations.read(id, "generation-request")).value;
          if (JSON.parse(request.messages[0].content[0].text).assessmentLevel === "final_adoption") {
            await interrupt({semanticPreparationId: id, savedStage: stageName, savedValue: value});
          }
        }
      };
    }
    if (scenario === "material_read_prepared") {
      const read = store.contextMaterials.read;
      store.contextMaterials.read = async (...args) => {
        const page = await read(...args);
        if (args[0] !== rootRunId && args[0] !== "unrelated-sibling") {
          const privatePage = await store.contextMaterials.search(args[0], {query:"Read transferred material"}, new AbortController().signal, "fixture-private-search");
          const privateRef = privatePage.matches.find(match => match.description.originRunId === args[0]).description.reference;
          const transfer = {id:"fixture-result-hold",sourceRunId:args[0],recipientRunId:rootRunId,references:[privateRef],basis:{kind:"result",id:"fixture-explicit-result"}};
          const secondTransfer = {...transfer,id:"fixture-independent-hold",basis:{kind:"frozen_request",id:"fixture-retained-request"}};
          await assert.rejects(store.contextMaterials.validate(rootRunId,[privateRef]), /not disclosed/);
          await store.contextMaterialRetention.prepare(transfer);
          await store.contextMaterialRetention.prepare(secondTransfer);
          await assert.rejects(store.contextMaterials.validate(rootRunId,[privateRef]), /not disclosed/);
          await interrupt({materialRef,readPage:page,readInvocationId:args[3],transfer,secondTransfer});
        }
        return page;
      };
    }
    if (scenario === "accepted" || scenario === "opening_prepared" || scenario === "continued_child" || scenario.startsWith("approval") || endingRecovery || interactionRecovery || contextRecovery || semanticRecovery || providerRecovery) {
      const commit = store.commitRunTree.bind(store);
      store.commitRunTree = async value => {
        const receipt = await commit(value);
        if (providerRecovery) {
          const failed = value.runs.flatMap(run => run.control.controllerCheckpoints)
            .find(([key, record]) => JSON.parse(key)[2].startsWith("provider-controller:retry:") && record.value?.attemptResult?.kind === "failed");
          if (failed) {
            assert.equal(failed[1].value.attemptResult.error.failure.statusCode, capacityRecovery ? 400 : 503);
            if (capacityRecovery) assert.equal(failed[1].value.attemptResult.error.failure.code, "provider_context_window_exceeded");
            assert.equal(Object.hasOwn(failed[1].value.attemptResult.error.failure, "retryAfterMs"), false);
            await interrupt({failureCheckpoint: failed});
          }
        }
        if (contextRecovery && preparationId) {
          const entries = value.runs.flatMap(run => run.control.controllerCheckpoints).map(([key, record]) => [JSON.parse(key)[2], record]);
          if (scenario === "context_selected" && entries.some(([key, record]) => key === "context-preparation:selected.v1" && record.id === preparationId)) await interrupt({preparationId});
          if (scenario === "context_frozen" && entries.some(([key, record]) => key.startsWith("context-preparation:dispatch:") && record.preparationId === preparationId)) await interrupt({preparationId});
          if (scenario === "context_returned" && calls === 2 && entries.some(([key, record]) => key.startsWith("provider-controller:retry:") && record.value?.outcome?.kind === "succeeded" &&
            record.value.outcome.value?.response?.turn?.responseRef.responseId === "verification:seed:2")) await interrupt({preparationId});
          if (scenario === "context_accepted" && value.runs.some(run => run.state.items.some(item => item.payload.kind === "controller_turn" &&
            item.payload.modelItems?.some(model => model.kind === "model_response_correlation" && model.response.responseId === "verification:seed:2")))) await interrupt({preparationId});
        }
        if (scenario === "opening_prepared") {
          const opening = value.runs.flatMap(run => run.control.controllerCheckpoints)
            .find(([key]) => JSON.parse(key)[2] === "working-conversation-opening.v1");
          if (opening) await interrupt({opening: opening[1]});
        }
        if (scenario === "continued_child" && value.runs.some(run => run.admission?.modelInteractionSeed)) await interrupt({materialRef});
        if (interactionRecovery) {
          const runs = value.runs;
          const entries = runs.flatMap(run => run.state.items.map(item => item.payload));
          const feedback = entries.some(item => item.kind === "input_notification" && item.notification.interpretation?.kind === "controller_feedback");
          if (scenario === "interaction_admitted" && feedback) await interrupt();
          if (scenario === "interaction_steering" && entries.some(item =>
            item.kind === "input_notification" && item.notification.interpretation?.kind === "steering")) await interrupt();
          if (scenario === "interaction_call_feedback" && entries.some(item => item.kind === "controller_feedback")) await interrupt();
          if (scenario === "interaction_accepted" && entries.some(item => item.kind === "input_delivery" &&
            item.batch.entries.some(entry => entry.interpretation?.kind === "controller_feedback"))) await interrupt();
          if (scenario === "interaction_prepared" && feedback) {
            const retained = runs.flatMap(run => run.control.controllerCheckpoints).find(([key, record]) =>
              JSON.parse(key)[2].startsWith("provider-controller:provider-request:") &&
              record.value?.composition.sections.some(section => section.kind === "input_notification"));
            if (retained) await interrupt({preparedRequest: retained[1].value});
          }
        }
        if (endingRecovery && value.runs.some(run => run.control.controllerCheckpoints.some(([key, state]) =>
          JSON.parse(key)[2] === "helarc.ending-signal-recovery" && state.consecutiveMissing === 2))) {
          await interrupt();
        }
        if (scenario === "accepted" && value.runs.some(run => run.control.decision?.status === "active")) await interrupt();
        if (scenario === "approval") {
          const pending = value.runs.flatMap(run => run.state.pending).find(item => item.kind === "interaction");
          if (pending) await interrupt({approval: pending.interaction.request});
        }
        if (scenario === "approval_applied") {
          if (value.runs.some(run => run.control.interactions.records.some(record => record.settlement?.status === "resolved"))) await interrupt();
          if (!submissionStarted && value.runs.some(run => run.state.pending.some(item => item.kind === "interaction"))) {
            submissionStarted = true;
            setTimeout(() => {
              const pending = seedExecution.activeRun.getStatus().pendingInteractions[0];
              const review = pending.presentation, submissionId = "original-approval";
              void seedExecution.activeRun.submitInteraction({request: pending.request, submissionId, payload: {
                submissionId, runId: review.runId, requestId: review.id, pendingVersion: pending.request.requestVersion,
                optionId: review.decisionOptions.find(option => option.kind === "accept").id, grantedPermissions: null, reason: null,
              }}).catch(error => {throw error;});
            }, 25);
          }
        }
        return receipt;
      };
    } else {
      const record = store.commitExecutionEvidence.bind(store);
      store.commitExecutionEvidence = async value => {
        await record(value);
        if (materialRecovery) {
          if (scenario === "material_child" && value.source.result.invocation.operation.operation.name === "context-read" && value.source.correlation.run.id !== rootRunId) await interrupt({materialRef});
          return;
        }
        assert.equal(await readFile(marker, "utf8"), "x");
        const runId = value.source.correlation.run.id;
        const processes = await store.readProcesses(runId);
        assert.equal(processes.length, 1);
        assert.equal(processes[0].snapshot.phase, "settled");
        await interrupt({actionId: processes[0].input.actionId, actionRunId: runId});
      };
    }
    seedExecution = prepared.start();
    const unexpected = await seedExecution.result;
    await writeFile(join(directory, "unexpected-result.json"), JSON.stringify({unexpected, requests}, null, 2));
    throw new Error(`Expected interruption was not reached: ${JSON.stringify(unexpected.runResult.cause)}`);
  }
  const seed = JSON.parse(await readFile(seedFile, "utf8")); rootRunId = seed.rootRunId;
  materialRef = seed.materialRef;
  const admission = await store.readProductRun(rootRunId);
  const recording = await store.registerRecording({sourceId:"recovery-test",datasetId:"resume",runId:rootRunId});
  const recordedResume = stage === "verify" && process.env.HELARC_RECOVERY_INSPECTION === "1"
    ? JSON.parse(await readFile(join(directory, "resume.json"), "utf8")).inspection : null;
  assert.deepEqual(recording.previous, recordedResume
    ? {sourceId: recordedResume.sourceId, datasetId: recordedResume.datasetId, runId: rootRunId}
    : {sourceId:"recovery-test",datasetId:"seed",runId:rootRunId});
  assert.deepEqual(await store.registerRecording(recording.current),recording);
  assert(store.generation > seed.generation);
  const original = store.restoreCommandEnvironment(admission.commandEnvironment);
  assert.notEqual(original.environment.FNM_MULTISHELL_PATH, process.env.FNM_MULTISHELL_PATH);
  assert.equal(original.environment.HELARC_NEW_HOST_ONLY, undefined);
  assert(!JSON.stringify(admission).includes(process.env.HELARC_RECOVERY_SECRET_TEST));
  const savedInput = {...common, task: admission.task, providerProfile: admission.providerProfile, instructionSettings: admission.instructionSettings, recoveryAdmission: admission};
  if (stage === "resume") {
    const before = await store.readRunTree(rootRunId);
    if (providerRecovery) {
      assert.deepEqual(before.members.flatMap(member => member.head.control.controllerCheckpoints)
        .find(([key]) => key === seed.failureCheckpoint[0]), seed.failureCheckpoint,
        "The failure must survive before its retry disposition is processed");
    }
    if (scenario === "material_read_prepared") {
      const child = before.members.find(member=>member.head.state.run.id !== rootRunId);
      assert.deepEqual(await store.contextMaterials.read(child.head.state.run.id,{reference:materialRef},new AbortController().signal,seed.readInvocationId),seed.readPage);
      await assert.rejects(store.contextMaterials.validate(rootRunId,seed.transfer.references), /not disclosed/);
      await store.contextMaterialRetention.accept(seed.transfer);
      await store.contextMaterialRetention.accept(seed.transfer);
      await store.contextMaterialRetention.accept(seed.secondTransfer);
      await store.contextMaterialRetention.release(seed.transfer.id);
      await assert.rejects(store.contextMaterialRetention.prepare(seed.transfer), /released/);
      await store.contextMaterials.validate(rootRunId,seed.transfer.references);
    }
    const prepared = await prepareHelarcHostRun(savedInput);
    const execution = await prepared.recover();
    const result = execution.result.catch(error => {writeFileSync(join(directory, "recovery-failure.log"), inspect(error, {depth: 8})); throw error;});
    // Attach before awaiting external input; early settlement errors must be observed.
    void result.catch(() => {});
    if (scenario === "approval") {
      const deadline = Date.now() + 15000;
      let pending;
      while (!(pending = execution.activeRun.getStatus().pendingInteractions[0])) {
        if (Date.now() >= deadline) throw new Error("Retained approval did not reopen");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.deepEqual(pending.request, seed.approval);
      await writeFile(join(directory, "restored-approval.json"), JSON.stringify(pending, null, 2));
      assert.equal(calls, 0);
      const submissionId = "recovery-verification-approval", review = pending.presentation;
      const submitted = await execution.activeRun.submitInteraction({request: pending.request, submissionId, payload: {
        submissionId, runId: review.runId, requestId: review.id, pendingVersion: pending.request.requestVersion,
        optionId: review.decisionOptions.find(option => option.kind === "accept").id, grantedPermissions: null, reason: null}});
      assert.equal(submitted.status, "accepted_for_resolution");
      await writeFile(join(directory, "submitted-approval.json"), JSON.stringify(submitted, null, 2));
    }
    const outcome = await result;
    assert.equal(outcome.runResult.status, scenario === "ending_exhausted" || capacityRecovery ? "failed" : "completed", JSON.stringify(outcome.runResult.cause));
    if (capacityRecovery) assert.equal(outcome.runResult.cause.failure.failure.code, "model_context_capacity_exceeded", JSON.stringify(outcome.runResult.cause));
    if (scenario === "ending_exhausted") assert.equal(outcome.runResult.cause.failure.failure.code,
      "model_protocol_recovery_exhausted", JSON.stringify(outcome.runResult.cause));
    assert.equal(await readFile(marker, "utf8"), "x");
    const after = await store.readRunTree(rootRunId);
    assert.deepEqual(after.commit.checkpoint.input, before.commit.checkpoint.input);
    if (scenario.startsWith("approval")) {
      assert.equal(after.commit.checkpoint.approvals.totalRequests, 1);
      assert.equal(after.commit.checkpoint.approvals.settledRequests, 1);
      assert.deepEqual(after.commit.checkpoint.approvals.active, []);
      assert.equal(after.members[0].head.control.interactions.records.length, 1);
    }
    assert.deepEqual(after.members.map(value => value.head.state.run.id).sort(), before.members.map(value => value.head.state.run.id).sort());
    for (const previous of before.members) {
      const next = after.members.find(value => value.head.state.run.id === previous.head.state.run.id);
      assert.deepEqual(next.head.state.items.slice(0, previous.head.state.items.length), previous.head.state.items);
      const appended = next.head.state.items.slice(previous.head.state.items.length);
      assert.equal(next.head.state.counters.runActions, previous.head.state.counters.runActions +
        appended.filter(item => item.payload.kind === "run_action").length);
      assert.equal(next.head.state.counters.observations, previous.head.state.counters.observations +
        appended.filter(item => item.payload.kind === "observation").length);
      const replayedTurn = endingRecovery || scenario === "context_returned" || capacityRecovery ? 1 : 0;
      assert.equal(next.head.state.counters.controllerTurns, previous.head.state.counters.controllerTurns +
        requests.filter(request => request.metadata.runId === previous.head.state.run.id && !request.composition.lineage.auxiliary).length + replayedTurn);
      assert.equal(next.head.state.startedAt, previous.head.state.startedAt);
      assert.equal(next.head.state.deadlineAt, previous.head.state.deadlineAt);
      assert.equal(next.head.state.plan.steps[0].status, scenario === "ending_exhausted" || capacityRecovery ? "in_progress" : "completed");
      if (previous.head.state.plan) assert.equal(next.head.state.plan.id, previous.head.state.plan.id);
    }
    const processes = (await Promise.all(after.members.map(member => store.readProcesses(member.head.state.run.id)))).flat();
    assert.equal(processes.length, 1);
    assert.equal(processes[0].input.environment.HELARC_NEW_HOST_ONLY, undefined);
    assert.deepEqual(processes[0].input.environment, original.environment);
    const recordedRequests = contextRecovery || semanticRecovery || capacityRecovery ? [...(await readFile(join(directory, "seed-provider-requests.jsonl"), "utf8")).trim().split("\n").map(JSON.parse), ...requests] : requests;
    const shellRequest = recordedRequests.find(request => JSON.stringify(request.messages.filter(message => message.role === "tool")).includes("completed once"));
    assert(shellRequest, "The completed command result must reach the model after restart");
    if (!backgroundSemantic) assert.equal(calls, capacityRecovery ? 0 : semanticRecovery ? scenario === "semantic_leaf" ? 5 : ["semantic_generated", "semantic_merge"].includes(scenario) ? 2 : 1 : ["context_returned", "context_accepted"].includes(scenario) ? 0 : materialRecovery || scenario === "continued_child" ? 3 : ["child", "opening_prepared"].includes(scenario) ? 2 : 1);
    if (capacityRecovery) {
      const rejected = seed.failureCheckpoint[1].value.attemptResult;
      const saved = after.members.flatMap(member => member.head.control.controllerCheckpoints)
        .find(([key]) => key === seed.failureCheckpoint[0])[1];
      assert.deepEqual(saved.value.attemptResult, rejected);
      assert.equal(saved.value.outcome.kind, "failed");
      assert.equal(requests.length, 0, "A saved capacity rejection must not resend the rejected request");
    }
    if (semanticRecovery) {
      assert.deepEqual(await store.contextPreparations.read(seed.semanticPreparationId, seed.savedStage), seed.savedValue);
      const auxiliary = recordedRequests.filter(request => request.composition.lineage.auxiliary);
      const expectedAuxiliary = backgroundAdopt ? auxiliary.length : backgroundSemantic ? 1 : stagedSemantic ? 6 : 2;
      if (!backgroundAdopt) assert.equal(auxiliary.length, expectedAuxiliary, "Retained completed auxiliary responses must not be regenerated");
      assert.equal(new Set(auxiliary.map(request => request.requestId)).size, expectedAuxiliary);
      if (backgroundAdopt) {
        assert.equal(requests.filter(request => request.composition.lineage.auxiliary).length, 0, "Saved generation and assessment must not run again after restart");
        const generation = auxiliary.filter(request => request.purpose === "context_generation");
        assert(generation.length >= 1);
        const scopes = generation.map(request => JSON.stringify(JSON.parse(request.messages[0].content[0].text).replacementSources));
        assert.equal(new Set(scopes).size, scopes.length, "Different generations must replace different frozen source scopes");
        assert.equal(auxiliary.filter(request => request.purpose === "context_assessment").length, 1);
      }
      const final = requests.find(request => !request.composition.lineage.auxiliary);
      if (backgroundSemantic) {
        assert.equal(auxiliary[0].metadata.contextPreparationPriority, "background");
        assert.equal(final.composition.workingView.accounts?.length ?? 0, backgroundAdopt ? 1 : 0, "Adoption follows current need, not sunk cost");
        if (backgroundAdopt) {
          assert.notEqual(auxiliary[0].metadata.transformationBasis, auxiliary[1].metadata.transformationBasis, "Generation and final adoption have different frozen backgrounds");
          assert(final.composition.workingView.accounts[0].sources.length > 0);
        }
      } else assert.equal(final.composition.workingView.accounts.length, 1);
      if (!stagedSemantic && !backgroundSemantic) {
        // A process notification can change the first pressured boundary. Verify
        // the actual assessed scope, not a timing-dependent preferred interval.
        const assessed = auxiliary.find(request => request.purpose === "context_assessment");
        const basis = JSON.parse(assessed.messages[0].content[0].text);
        const selectedIds = new Set(final.composition.workingView.accounts[0].sources.map(source => source.sectionId));
        const projection = assessed.metadata.evidenceProjection;
        const resolveId = label => projection.mapping.find(entry => entry.label === label).sectionId;
        assert.deepEqual([...selectedIds], basis.replacementSources.map(section => resolveId(section.id)));
        for (const section of basis.readOnlyBackground) {
          const id = resolveId(section.id);
          assert.equal(modelInputValueDigest(final.composition.sections.find(value => value.id === id)),
            projection.sections.find(entry => entry.sectionId === id).digest);
        }
        assert(final.composition.sections.every(section => !selectedIds.has(section.id)));
      } else if (stagedSemantic) {
        assert(final.composition.workingView.accounts[0].limitations.includes("assessment_uses_derived_accounts_not_original_reread"));
        assert(final.composition.workingView.accounts[0].limitations.includes("omitted_detail:Repetitive report padding"));
        assert.equal(final.composition.workingView.accounts[0].derivation.evidence.length, 2);
      }
      assert(JSON.stringify(final.messages).includes("completed once"));
      const charges = after.members[0].head.control.controllerCheckpoints.filter(([key]) => JSON.parse(key)[2].startsWith("controller-auxiliary-usage.v1:"));
      assert.equal(charges.length, expectedAuxiliary, "Each physical auxiliary attempt is accounted once across restart");
      assert.deepEqual(charges.map(([, value]) => value.usage.inputTokens), Array(expectedAuxiliary).fill(101));
      const turns = after.members[0].head.state.items.filter(item => item.payload.kind === "controller_turn" && item.payload.status === "decided");
      if (!backgroundSemantic) assert.equal(turns.length, recordedRequests.filter(request => !request.composition.lineage.auxiliary).length);
    }
    if (contextRecovery) {
      const candidate = await store.contextPreparations.read(seed.preparationId, "candidate");
      const frozen = await store.contextPreparations.read(seed.preparationId, "frozen");
      assert.equal(candidate.status, "ready"); assert.equal(frozen.status, "ready");
      assert.deepEqual(shellRequest.composition, frozen.value.composition, "Working input must remain exact across process interruption");
      const selected = after.members[0].head.control.controllerCheckpoints.find(([key]) => JSON.parse(key)[2] === "context-preparation:selected.v1")[1];
      assert.equal(selected.id, seed.preparationId);
      assert.equal(selected.epoch, 2);
      const turns = after.members[0].head.state.items.filter(item => item.payload.kind === "controller_turn" && item.payload.status === "decided");
      assert.equal(turns.length, 2, "Recovery must not duplicate accepted Turns");
    }
    for (const request of requests) {
      if (request.composition.lineage.auxiliary) continue;
      const member = after.members.find(member => member.head.state.run.id === request.metadata.runId);
      const accepted = member.head.state.items.flatMap(item => item.payload.kind === "controller_turn" && item.payload.status === "decided" ? item.payload.modelItems : []);
      const correlation = accepted.find(item => item.kind === "model_response_correlation" && item.response.requestId === request.requestId);
      if (correlation) {
        assert(correlation.metadata.inputUsageObservation, "Accepted input usage must survive SQLite Worker persistence");
        assert.equal(correlation.metadata.inputUsageObservation.runId, request.metadata.runId);
      } else {
        assert.equal(scenario, "ending_exhausted", "This fixture only leaves the exhausted final response unaccepted");
        assert(!accepted.some(item => item.metadata.inputUsageObservation?.requestId === request.requestId), "An unaccepted response cannot supply an anchor");
      }
      const anchor = request.modelContext.assessment.planning.anchor;
      if (anchor) assert(member.head.state.items.some(item => item.payload.kind === "controller_turn" && item.payload.modelItems.some(model =>
        model.metadata.inputUsageObservation?.id === anchor.id)), "Anchor must reference an accepted local exchange, including across processes");
      assert.equal(request.instructions.content.length, 0, "Recovery must not enable optional Instructions");
      assert(!request.composition.sections.some(section => section.kind === "active_run_context"));
      assert(!JSON.stringify(request.messages).includes("Context projection:"));
    }
    for (const member of after.members) {
      const openings = member.head.state.items.filter(item => item.payload.kind === "controller_turn" && item.payload.openingReceipt);
      assert.equal(openings.length, 1, "Each Run accepts its exact opening only once");
      const opening = openings[0].payload.openingReceipt;
      assert.equal(opening.runId, member.head.state.run.id);
      const matching = requests.filter(request => request.metadata.runId === opening.runId && !request.composition.lineage.auxiliary);
      for (const request of matching) {
        if (semanticRecovery && request.composition.workingView.accounts?.length) continue;
        const sections = request.composition.sections.filter(section => ["conversation_opening", "conversation_opening_history"].includes(section.kind));
        assert.deepEqual(sections.map(section => section.content), opening.presentations.map(value => value.section.content));
        assert.equal(sections.filter(section => section.provenance.purpose === "assignment").length, 1);
      }
    }
    if (scenario === "opening_prepared") {
      assert.equal(seed.calls, 0);
      const opening = after.members[0].head.state.items.find(item => item.payload.kind === "controller_turn" && item.payload.openingReceipt).payload.openingReceipt;
      assert.deepEqual(opening.presentations, seed.opening.presentations);
    }
    if (scenario === "continued_child") {
      assert.equal(after.members.length, 3);
      const continued = after.members.find(member => member.admission?.modelInteractionSeed || member.head.admission?.modelInteractionSeed);
      assert(continued, "The continued Child retains its scoped seed admission");
      const request = requests.find(request => request.metadata.runId === continued.head.state.run.id);
      assert.equal(request.modelContext.assessment.planning.anchor, null, "Imported Child history cannot import its usage anchor");
      const imported = request.composition.sections.filter(section => section.provenance?.purpose === "imported_history");
      assert(imported.length > 0);
      assert(imported.every(section => section.provenance.recipientRunId === request.metadata.runId &&
        section.provenance.originRunId !== request.metadata.runId && section.provenance.originRunId !== rootRunId));
      assert.equal(request.composition.sections.filter(section => section.provenance?.purpose === "assignment").length, 1);
      assert(request.composition.sections.find(section => section.provenance?.purpose === "assignment").content.text.includes("Explain the retained finding"));
      assert.deepEqual((continued.admission ?? continued.head.admission).delegationRequest.task.input.material_refs, [materialRef]);
      const page = await store.contextMaterials.read(continued.head.state.run.id, {reference: materialRef}, new AbortController().signal, "verify-continuation-material");
      assert(page.text.includes("Append one marker"));
      await assert.rejects(store.contextMaterials.read("unrelated-sibling", {reference: materialRef}, new AbortController().signal, "forbidden-continuation-material"), /not disclosed/);
    }
    if (endingRecovery) {
      const state = after.members[0].head.control.controllerCheckpoints.find(([key]) =>
        JSON.parse(key)[2] === "helarc.ending-signal-recovery")[1];
      assert.equal(state.consecutiveMissing, scenario === "ending_exhausted" ? 3 : 0);
      assert.equal(state.disposition, scenario === "ending_exhausted" ? "exhausted" : "reset");
      assert.equal(seed.calls, 3, "One command turn plus two correction turns before restart");
      assert(requests.every(request => request.instructions.content.length === 0), "Recovery must not enable System Instructions");
    }
    if (interactionRecovery) {
      const items = after.members[0].head.state.items;
      const feedbackItems = items.filter(item => item.payload.kind === "controller_feedback");
      const notifications = items.filter(item => item.payload.kind === "input_notification" && item.payload.notification.interpretation);
      const deliveries = items.filter(item => item.payload.kind === "input_delivery" &&
        item.payload.batch.entries.some(entry => entry.interpretation));
      assert(requests.every(request => request.instructions.content.length === 0), "No System Instructions may be enabled");
      const request = requests[0];
      if (scenario === "interaction_call_feedback") {
        assert.equal(feedbackItems.length, 1);
        assert.equal(notifications.length, 0);
        const rejection = items.find(item => item.payload.kind === "model_call_settlement" &&
          item.payload.result.content.code === "completion_calls_not_successful");
        assert(rejection, "Completion refusal must be a correlated result");
        assert.equal(rejection.committedInRevision, feedbackItems[0].committedInRevision);
        assert.equal(rejection.payload.result.content.message, feedbackItems[0].payload.feedback.message);
        const supplied = request.messages.filter(message => message.role === "tool").flatMap(message => message.content)
          .filter(block => block.result?.modelCallRef.id === rejection.payload.result.modelCallRef.id);
        assert.equal(supplied.length, 1);
        assert.equal(supplied[0].result.content.message, feedbackItems[0].payload.feedback.message);
      } else {
        assert.equal(feedbackItems.length, scenario === "interaction_steering" ? 0 : 1);
        assert.equal(notifications.length, 1);
        assert.equal(deliveries.length, 1);
        const delivered = deliveries[0].payload;
        assert.deepEqual(delivered.batch.entries, [notifications[0].payload.notification]);
        const consumedIndex = items.indexOf(deliveries[0]) + 1;
        assert.equal(items[consumedIndex].payload.kind, "controller_turn");
        assert.equal(items[consumedIndex].payload.turn.id, delivered.turn.id);
        assert.equal(items[consumedIndex].committedInRevision, deliveries[0].committedInRevision);
        const heading = scenario === "interaction_steering" ? "Applied steering instruction:" : "Host Controller feedback:";
        const messages = request.messages.flatMap(message => message.content.map(block => ({role: message.role, text: block.text ?? ""})));
        assert.equal(messages.filter(message => message.text.startsWith(heading)).length, 1);
        const section = request.composition.sections.find(section => section.content.kind === "model_message" &&
          section.content.message.content.some(block => block.text?.startsWith(heading)));
        assert(section, "The delivered input must have an explicit request section");
        const current = request.composition.sections.find(section => section.kind === "context_projection");
        assert.equal(current, undefined);
        if (scenario === "interaction_prepared") assert.deepEqual(request, seed.preparedRequest, "Recovery must reuse the exact saved request");
        if (scenario === "interaction_accepted") {
          const index = messages.findIndex(message => message.text.startsWith(heading));
          assert.equal(messages[index + 1].role, "assistant", "Feedback must stay before the response that consumed it");
        }
      }
      const settlements = items.filter(item => item.payload.kind === "model_call_settlement").map(item => item.payload.result.modelCallRef.id);
      assert.equal(new Set(settlements).size, settlements.length, "No Call may settle twice");
      assert.equal(new Set(items.map(item => item.ref.id)).size, items.length);
    }
    assert.equal((await store.listProductRuns())[0].delivered, false);
    if (seed.actionId) {
      const records = await store.readAction({runId: seed.actionRunId, action: {id: seed.actionId}});
      assert.equal(records.attempts.length, 1);
    }
    let inspectionEvidence = null;
    if (inspection) {
      await inspection.close();
      const health = inspection.recorder.health();
      assert.equal(health.dropped, 0); assert.equal(health.rejected, 0);
      assert.equal(health.unpersisted, 0); assert.equal(health.unconfirmed, 0);
      const {InspectionQueryService} = await import("@agent-anything/inspection/query");
      const query = new InspectionQueryService(inspectionRoot);
      try {
        const selection = (await query.query({kind: "get_snapshot", sourceId: inspection.recorder.source.sourceId,
          datasetId: inspection.recorder.manifest.datasetId})).selection;
        const records = [];
        let next;
        do {
          const page = await query.query({...selection, kind: "list_records", runId: rootRunId,
            includeDescendants: true, limit: 500, ...(next ? {after: next} : {})});
          records.push(...page.records); next = page.next;
        } while (next);
        if (scenario === "continued_child" || materialRecovery) {
          const reads = records.filter(record => record.payload.kind === "event" && record.payload.name === "context.material.read");
          assert(reads.some(record => record.links.some(link => link.kind === "delivers" && link.from.id === materialRef.id)),
            "Inspector must correlate the recovered material read with its immutable source");
          const content = reads.flatMap(record => record.contents).find(value => value.name === "Material access coverage");
          assert(content && content.availability === "present");
          const value = JSON.parse((await query.query({...selection, kind: "get_content", contentId: content.id})).content.text);
          assert(value.references.some(ref => ref.id === materialRef.id && ref.revision === materialRef.revision));
        }
        const bindings = records.filter(record => record.payload.kind === "event" && record.payload.name === "Model activity binding");
        assert(bindings.length > 0, "Actual recovered model access must be recorded");
        for (const record of bindings) {
          const content = record.contents.find(value => value.name === "Model activity binding");
          assert.equal(content.availability, "present");
          const value = JSON.parse((await query.query({...selection, kind: "get_content", contentId: content.id})).content.text);
          assert.equal(value.runId, record.subject.runId);
          assert.equal(value.id, record.subject.id);
        }
        const allocations = records.flatMap(record => record.contents).filter(content => content.name === "Model input allocation");
        // Restoring already-frozen input does not repeat its earlier measurement.
        if (backgroundAdopt) assert(allocations.length > 0, "Fresh adoption must expose its allocation material");
        for (const content of allocations) {
          const value = JSON.parse((await query.query({...selection, kind: "get_content", contentId: content.id})).content.text);
          assert.equal(value.unit, "tokens");
          assert.equal(typeof value.estimator.accuracy, "string");
          assert(value.uncertainty);
          assert(value.groups.every(group => typeof group.allocatedAmount === "number" && !Object.hasOwn(group, "grant")));
        }
        const step = records.find(record => record.payload.kind === "flow_step" && record.payload.observation.kind === "step_entered" &&
          record.payload.observation.definition.id === "model-activity-access" && record.payload.observation.stepId === "binding");
        assert(step);
        const fact = step.payload.observation;
        const detail = await query.query({...selection, kind: "get_flow_occurrence", runId: fact.runId,
          invocationId: fact.invocationId, occurrenceId: fact.stepExecutionId});
        assert(detail.flow.occurrence.references.some(ref => ref.role === "output" && ref.availability === "present" &&
          ref.reference.kind === "model_activity"), "Activity material must resolve through the Inspector query path");
        assert(records.some(record => record.payload.kind === "recording_link" && record.payload.target?.datasetId === "resume"));
        inspectionEvidence = {...selection, recordCount: records.length, modelActivityBindings: bindings.length,
          allocationMaterials: allocations.length, resolvedActivity: true};
      } finally { await query.close(); }
    }
    await writeFile(join(directory, "resume.json"), JSON.stringify({scenario, status: outcome.runResult.status, effects: 1, modelCalls: calls,
      ...(inspectionEvidence ? {inspection: inspectionEvidence} : {}),
      members: after.members.length, originalItemsPreserved: true, countersAndDeadlinesPreserved: true,
      environmentRestoredExactly: true, electron: process.versions.electron, sqliteWorkerGeneration: store.generation}));
  } else {
    assert.equal((await store.listProductRuns())[0].terminal, true);
    assert.equal((await store.listProductRuns())[0].delivered, false);
    if (scenario === "material_read_prepared") {
      await store.contextMaterialRetention.accept(seed.secondTransfer);
      await assert.rejects(store.contextMaterialRetention.accept(seed.transfer), /released/);
    }
    await store.commitProductDelivery(rootRunId); await store.commitProductDelivery(rootRunId);
    if (scenario === "material_read_prepared") {
      await assert.rejects(store.contextMaterialRetention.accept(seed.secondTransfer), /released/);
      await assert.rejects(store.contextMaterialRetention.prepare({...seed.transfer,id:"fixture-late-consumer"}), /released/);
      await store.contextMaterialRetention.release("fixture-cancelled-before-prepare");
      await assert.rejects(store.contextMaterialRetention.prepare({...seed.transfer,id:"fixture-cancelled-before-prepare"}), /released/);
    }
    assert.equal((await store.listProductRuns())[0].delivered, true);
    assert.equal(await readFile(marker, "utf8"), "x"); assert.equal(calls, 0);
    const corrupted = {...admission, commandEnvironment: {...admission.commandEnvironment, digest: "invalid"}};
    await assert.rejects(prepareHelarcHostRun({...savedInput, recoveryAdmission: corrupted}), /digest_mismatch/);
    const changed = {...admission, commandEnvironment: {...admission.commandEnvironment, shell: {...admission.commandEnvironment.shell,
      executable: {...admission.commandEnvironment.shell.executable, canonicalPath: "unavailable-shell"}}}};
    await assert.rejects(prepareHelarcHostRun({...savedInput, recoveryAdmission: changed}), /shell_dependency_changed/);
    const pathChanged = {...admission, commandEnvironment: {...admission.commandEnvironment,
      paths: admission.commandEnvironment.paths.map((value, index) => index === 0 ? {...value, target: {...value.target, inode: "changed"}} : value)}};
    await assert.rejects(prepareHelarcHostRun({...savedInput, recoveryAdmission: pathChanged}), /path_dependency_changed/);
    const ciphertextChanged = {...admission, commandEnvironment: {...admission.commandEnvironment,
      environment: {...admission.commandEnvironment.environment, ciphertext: "invalid"}}};
    await assert.rejects(prepareHelarcHostRun({...savedInput, recoveryAdmission: ciphertextChanged}), /decryption_failed/);
    assert.equal(calls, 0);
  }
  await store.close();
  await diagnostics.flush();
  const performanceReport = JSON.parse(await readFile(join(directory, `diagnostics-${stage}`, "execution-performance.json"), "utf8"));
  assert.equal(performanceReport.active.length, 0, "All Worker/Host timing spans must settle on close");
  for (const stage of ["storage.host.encode", "storage.host.queue", "storage.host.round_trip",
    "storage.worker.command", "storage.worker.dispatch", "storage.worker.encode_reply"]) {
    assert(Object.keys(performanceReport.totals).some(key => key.startsWith(`${stage}:`)), `Missing timing stage: ${stage}`);
  }
  for (const name of ["execution.sqlite", "execution.sqlite-wal"]) {
    const bytes = await readFile(join(directory, "execution", name)).catch(error => {if (error.code === "ENOENT") return Buffer.alloc(0); throw error;});
    assert.equal(bytes.includes(Buffer.from(process.env.HELARC_RECOVERY_SECRET_TEST)), false, "Environment plaintext leaked to SQLite");
  }
  app.quit();
}
main().catch(async error => {
  const details = inspect(error, {depth: 8});
  await appendFile(join(directory, "failure.log"), `${stage}: ${details}\n`).catch(() => {});
  process.stderr.write(`${details}\n`);
  app.exit(1);
});
