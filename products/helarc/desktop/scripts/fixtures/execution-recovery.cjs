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
app.setPath("userData", join(directory, "electron-user-data"));
app.disableHardwareAcceleration();
globalThis.fetch = async () => {throw new Error("This recovery verification must not call a network Provider");};

async function main() {
  const {baselineScenarios}=await import("../execution-recovery-coverage.mjs");
  assert(baselineScenarios.includes(scenario),"Retired recovery scenarios must use verify-execution-recovery.mjs and its explicit current coverage mapping");
  assert(["seed","resume","verify"].includes(stage),"Unknown recovery fixture phase");
  await app.whenReady();
  assert.equal(safeStorage.isEncryptionAvailable(), true);
  const load = path => import(pathToFileURL(join(__dirname, "../../dist/main", path)).href);
  const {HelarcExecutionStore} = await load("execution-storage/HelarcExecutionStore.js");
  const {ElectronSafeStorageCredentialCipher} = await load("provider/ElectronSafeStorageCredentialCipher.js");
  const {prepareHelarcHostRun} = await load("run/HelarcHostRunComposition.js");
  const {createHelarcActivityHost}=await load("context/HelarcActivityHost.js");
  const {createStaticHostIdentityResolver, createStaticHostWorkspaceResolver} = await import("@agent-anything/host/context");
  const {createHelarcTask} = await import("@agent-anything/helarc/task");
  const {createHelarcProviderProfile} = await import("@agent-anything/helarc/configuration");
  const {createFakeProviderContext} = await import("@agent-anything/test-support");
  const {OpenAICompatibleProvider} = await import("@agent-anything/provider-integrations/openai-compatible");
  const {createModelCallRef, createModelTurnId, snapshotModelCallableRequest, snapshotProviderResponse, createUnknownModelInputMeasurement} = await import("@agent-anything/model-interaction");
  const {selectModelWorkingView} = await import("@agent-anything/model-interaction/input");
  const {createConversationOpeningReceipt} = await import("@agent-anything/agent-runtime/decision");
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
    inspection?.fileMaterialObserver, diagnostics, new ElectronSafeStorageCredentialCipher(), inspection?.contextMaterialObserver,inspection?.activityObserver,inspection?.contextFoundationObserver);
  const activityHost=createHelarcActivityHost(store,{diagnostics});
  const seedFile = join(directory, "seed.json");
  let rootRunId, calls = 0, seedExecution, materialRef;
  const requests = [];
  const runCalls = new Map();
  const providerId = "openai-compatible.chat-completions";
  const context = createFakeProviderContext(providerId, "deterministic-verification-model");
  let encodedRequest = null;
  const wireAdapter = new OpenAICompatibleProvider({baseUrl: "https://encoded.test/v1", apiKey: "", model: "deterministic-verification-model",
    timeoutMs: 30000, nativeToolInteraction: {supported: true}, requestBodyTransportLimit: {
      maximumBytes: 16 * 1024 * 1024, source: "host_configured", revision: "verification-v1"}}, async (_url, init) => {
    encodedRequest = JSON.parse(init.body);
    return new Response(JSON.stringify({error: {message: "No network: serialization verification only"}}), {status: 503});
  });
  const provider = {modelContext: {...context.modelContext, accounting: {...wireAdapter.modelContext.accounting,
      basis: {fixture: "deterministic-usage.v1"}, inputUsage: "complete", outputUsage: "complete", limitations: ["synthetic_usage_not_endpoint_qualification"]},
      measure(composition, measuredAt) {return createUnknownModelInputMeasurement({compositionId: composition.id, measuredAt, reason: "unsupported"});}},
    encodeInput: (request, mode) => wireAdapter.encodeInput(request, mode),
    verifyEncodedInput:(request,encoded)=>wireAdapter.verifyEncodedInput(request,encoded),
    requestBodyTransportLimit: context.requestBodyTransportLimit,
    descriptor: {id: providerId, name: "Recovery verification", metadata: {}, capabilities: {
      nativeToolInteraction: {supported: true, callableDefinitions: true, modelCalls: true, resultMessages: true, multipleCalls: true, callCorrelation: "provider_supplied"},
      structuredGeneration: {supported: true}, streaming: {supported: false},
      modelContext: {capacity: context.modelContext.capacity,
        requestedOutput: context.modelContext.requestedOutput, inputPreservation: context.modelContext.inputPreservation},
      continuation: {supported: false}, compaction: {supported: false}, usageMetering: {inputTokens: "unavailable", outputTokens: "unavailable", costUnits: "unavailable"}},
      requestRetryScheduler: {kind: "harness"}},
    async send(request, interruption, options) {
      assert(options?.encodedInput,"Original prepared input is required");
      wireAdapter.verifyEncodedInput(request,options.encodedInput);
      requests.push(request); calls++;
      await appendFile(join(directory, `${stage}-provider-requests.jsonl`), JSON.stringify(request) + "\n");
      assert.equal(request.composition.workingView.recipientRunId, request.metadata.runId);
      assert.equal(request.composition.workingView.boundary, "request");
      assert.deepEqual(selectModelWorkingView(request.composition.workingView, request.composition.sections), request.composition.sections);
      assert(request.composition.workingView.nativeGroups.every(group => group.status === "settled"));
      const assessment=request.modelContext.assessment;
      assert.equal(assessment.compositionId,request.composition.id);
      assert.equal(assessment.measurement.measuredCompositionId,request.composition.id);
      assert.equal(assessment.revision,"context-input-preparation:1");
      assert.notEqual(assessment.disposition,"exceeded");
      encodedRequest = null;
      const wire = await wireAdapter.send(request, interruption);
      assert(encodedRequest, `Actual Provider encoder did not produce a request: ${JSON.stringify(wire)}`);
      assert.equal(encodedRequest.workingView, undefined, "Selection metadata must not become a wire instruction");
      assert(!request.composition.lineage.auxiliary,"Run/effect baseline must not substitute for representation-method verification");
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
      const child = request.metadata.runId !== rootRunId;
      let requested;
      const originalCommand = () => {
        const command = process.platform === "win32"
          ? "if ($env:HELARC_NEW_HOST_ONLY) { throw 'Ambient environment leaked' }; [System.IO.File]::AppendAllText('executions.txt', 'x'); Write-Output 'completed once'"
          : "test -z \"$HELARC_NEW_HOST_ONLY\" || exit 9; printf x >> executions.txt; printf 'completed once\\n'";
        return [{name: "update_plan", input: {plan: [{step: "Append the execution marker", status: "in_progress"}]}},
          {name: process.platform === "win32" ? "PowerShell" : "Bash", input: {command, timeout_ms: 10000, wait_ms: 10000}}];
      };
      if (materialRecovery) {
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
      } else if (scenario === "opening_prepared" && stage === "resume" && runCall === 1) {
        const seed=JSON.parse(await readFile(seedFile,"utf8"));
        assert.deepEqual(createConversationOpeningReceipt(rootRunId,request).presentations,seed.opening.presentations,
          "The first actual request must use the opening from the original committed source");
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
      const content = requested.map((call, ordinal) => ({kind: "model_tool_call", call: snapshotModelCallableRequest({
        modelCallRef: createModelCallRef({providerRequestId: request.requestId, controllerRequestId: request.correlation.controllerRequestId, turnId,
          contentBlockOrdinal: ordinal, branchId: request.correlation.branchId}),
        providerCallRef: {providerId: provider.descriptor.id, id: `${responseId}:${ordinal}`}, ordinal,
        name: ["final_result", "update_plan"].includes(call.name) ? call.name : request.interaction.callables.find(value => value.name.startsWith(`${call.name}_`)).name,
        input: call.input})}));
      if (requested.length === 0) content.push({kind: "text", text: `Ordinary report without an ending signal (${stage}:${calls}).`});
      return {kind: "succeeded", response: snapshotProviderResponse({kind: "native_tool_turn", turn: {turnId, assistant: {role: "assistant", content},
        finish: {kind: "normal"}, usage: {inputTokens: 1000 + runCall * 100, outputTokens: 12,
          totalTokens: 1000 + runCall * 100 + 12, costUnits: null, metadata: {}},
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
    executionStore: store,activityHost, commandOutputDirectory: join(directory, "command-output"),
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
    if (scenario === "interaction_prepared") {
      let selectedStageId=null;
      const command=store.activityHandoffs.command.bind(store.activityHandoffs);
      store.activityHandoffs.command=async value=>{
        // Hold only the physical dispatch boundary while the test snapshots the
        // already committed input. No attempt or invented raw result is saved.
        if(value.kind==="dispatch"&&value.attempt.requestId===selectedStageId)await new Promise(()=>{});
        return command(value);
      };
      const accept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
      store.sharedAcceptance.accept=async proposal=>{
        const selected=proposal.parts.find(part=>part.owner==="context_selection"&&part.kind==="selection_input"&&
          part.proposal.input.exactInput?.kind==="prepared_context_input"&&
          part.proposal.input.exactInput.request.composition.sections.some(section=>section.kind==="input_notification"));
        if(selected)selectedStageId=selected.proposal.input.stageRequestId;
        const receipt=await accept(proposal);
        if(selected&&receipt.outcome==="accepted") {
          const input=selected.proposal.input;
          const binding=await store.contextSelections.command({kind:"binding",inputId:input.id,checkCurrentControl:false});
          const original=await command({kind:"read_stage",requestId:input.stageRequestId});
          assert.equal(binding.acceptanceId,receipt.id);assert.equal(binding.input.id,input.id);
          assert.deepEqual(binding.input.exactInput,input.exactInput);assert.deepEqual(original.request.input,input.exactInput);
          assert.equal(original.attempt,null);assert.equal(original.result,null);assert.equal(original.receipt,null);
          assert.equal(calls,2,"Only the command turn and the response requiring feedback may execute before this interruption");
          await interrupt({preparedRequest:input.exactInput.request,preparedInputId:input.id,
            preparedInputAcceptanceId:receipt.id,preparedStageRequest:original.request});
        }
        if(selected)selectedStageId=null;
        return receipt;
      };
    }
    if (scenario === "opening_prepared") {
      let sourceStageId=null;
      const command=store.activityHandoffs.command.bind(store.activityHandoffs);
      store.activityHandoffs.command=async value=>{
        if(value.kind==="dispatch"&&value.attempt.requestId===sourceStageId)await new Promise(()=>{});
        return command(value);
      };
      const accept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
      store.sharedAcceptance.accept=async proposal=>{
        const source=proposal.parts.find(part=>part.owner==="activity"&&part.kind==="stage_submission"&&
          part.proposal.input?.kind==="task_model_source"&&part.proposal.input.record.source.runId===rootRunId);
        if(source)sourceStageId=source.proposal.id;
        const receipt=await accept(proposal);
        if(source&&receipt.outcome==="accepted") {
          const original=await command({kind:"read_stage",requestId:sourceStageId});
          assert.deepEqual(original.request,source.proposal);
          assert.equal(original.attempt,null);assert.equal(original.result,null);assert.equal(original.receipt,null);
          assert.equal(await command({kind:"read_stage",requestId:`${original.request.pathId}:model`}),null);
          assert.equal(source.proposal.input.record.source.interaction.opening??null,null);
          const opening=createConversationOpeningReceipt(rootRunId,source.proposal.input.request);
          assert(opening,"The committed original source must contain the initial opening");
          assert.equal(calls,0,"Opening source admission must precede every Provider call");
          assert.deepEqual(await store.sharedAcceptance.query(receipt.id),receipt);
          await interrupt({opening,openingSourceStageRequest:original.request,openingSubmission:receipt});
        }
        if(source)sourceStageId=null;
        return receipt;
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
    if (scenario === "accepted" || scenario === "continued_child" || scenario.startsWith("approval") || endingRecovery || interactionRecovery) {
      const commit = store.commitRunTree.bind(store);
      store.commitRunTree = async value => {
        const receipt = await commit(value);
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
    } else if (scenario !== "opening_prepared") {
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
    if (scenario === "opening_prepared") {
      assert.equal(seed.calls,0);
      const original=await store.activityHandoffs.command({kind:"read_stage",requestId:seed.openingSourceStageRequest.id});
      assert.deepEqual(original.request,seed.openingSourceStageRequest);
      assert.equal(original.attempt,null);assert.equal(original.result,null);assert.equal(original.receipt,null);
      assert.deepEqual(await store.sharedAcceptance.query(seed.openingSubmission.id),seed.openingSubmission);
      assert.deepEqual(createConversationOpeningReceipt(rootRunId,original.request.input.request),seed.opening);
      assert(!before.members.some(member=>member.head.state.items.some(item=>item.payload.kind==="controller_turn"&&item.payload.openingReceipt)),
        "A retained opening source is not yet an accepted model exchange");
    }
    if (scenario === "interaction_prepared") {
      const binding=await store.contextSelections.command({kind:"binding",inputId:seed.preparedInputId,checkCurrentControl:false});
      const original=await store.activityHandoffs.command({kind:"read_stage",requestId:seed.preparedStageRequest.id});
      assert.equal(binding.acceptanceId,seed.preparedInputAcceptanceId);
      assert.deepEqual(binding.input.exactInput.request,seed.preparedRequest);
      assert.deepEqual(original.request,seed.preparedStageRequest);
      assert.equal(original.attempt,null);assert.equal(original.result,null);
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
    assert.equal(outcome.runResult.status, scenario === "ending_exhausted" ? "failed" : "completed", JSON.stringify(outcome.runResult.cause));
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
      const replayedTurn = endingRecovery ? 1 : 0;
      assert.equal(next.head.state.counters.controllerTurns, previous.head.state.counters.controllerTurns +
        requests.filter(request => request.metadata.runId === previous.head.state.run.id && !request.composition.lineage.auxiliary).length + replayedTurn);
      assert.equal(next.head.state.startedAt, previous.head.state.startedAt);
      assert.equal(next.head.state.deadlineAt, previous.head.state.deadlineAt);
      assert.equal(next.head.state.plan.steps[0].status, scenario === "ending_exhausted" ? "in_progress" : "completed");
      if (previous.head.state.plan) assert.equal(next.head.state.plan.id, previous.head.state.plan.id);
    }
    const processes = (await Promise.all(after.members.map(member => store.readProcesses(member.head.state.run.id)))).flat();
    assert.equal(processes.length, 1);
    assert.equal(processes[0].input.environment.HELARC_NEW_HOST_ONLY, undefined);
    assert.deepEqual(processes[0].input.environment, original.environment);
    const shellRequest = requests.find(request => JSON.stringify(request.messages.filter(message => message.role === "tool")).includes("completed once"));
    assert(shellRequest, "The completed command result must reach the model after restart");
    assert.equal(calls, materialRecovery || scenario === "continued_child" ? 3 : ["child", "opening_prepared"].includes(scenario) ? 2 : 1);
    for (const request of requests) {
      if (request.composition.lineage.auxiliary) continue;
      const member = after.members.find(member => member.head.state.run.id === request.metadata.runId);
      const accepted = member.head.state.items.flatMap(item => item.payload.kind === "controller_turn" && item.payload.status === "decided" ? item.payload.modelItems : []);
      const correlation = accepted.find(item => item.kind === "model_response_correlation" && item.response.requestId === request.requestId);
      if (correlation) {
        let observed=false,afterSequence=0;
        for(;;){
          const page=await store.contextFoundationFacts(request.metadata.runId,afterSequence,128);
          for(const fact of page)if(fact.kind==="input_usage_accepted"){
            const usage=fact.details.usage;
            const original=await store.activityHandoffs.command({kind:"read_stage",requestId:usage.stageId});
            if(original.request.input.request.requestId===request.requestId){
              assert.equal(usage.runId,request.metadata.runId);
              assert.equal(usage.encodedInputId,original.request.input.encoded.id);
              assert.equal(usage.rawResultId,original.result.id);observed=true;
            }
          }
          if(page.length<128)break;afterSequence=page.at(-1).sequence;
        }
        assert(observed,"Accepted input usage must survive SQLite Worker persistence with original stage and input");
      } else {
        assert.equal(scenario, "ending_exhausted", "This fixture only leaves the exhausted final response unaccepted");
      }
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
        const sections = request.composition.sections.filter(section => ["conversation_opening", "conversation_opening_history"].includes(section.kind));
        assert.deepEqual(sections.map(section => section.content), opening.presentations.map(value => value.section.content));
        assert.equal(sections.filter(section => section.provenance.purpose === "assignment").length, 1);
      }
    }
    if (scenario === "opening_prepared") {
      assert.equal(seed.calls, 0);
      const opening = after.members[0].head.state.items.find(item => item.payload.kind === "controller_turn" && item.payload.openingReceipt).payload.openingReceipt;
      assert.deepEqual(opening.presentations, seed.opening.presentations);
      const original=await store.activityHandoffs.command({kind:"read_stage",requestId:seed.openingSourceStageRequest.id});
      assert.deepEqual(original.request,seed.openingSourceStageRequest);
      assert.equal(original.status,"accepted");
      assert.deepEqual(await store.sharedAcceptance.query(seed.openingSubmission.id),seed.openingSubmission);
    }
    if (scenario === "continued_child") {
      assert.equal(after.members.length, 3);
      const continued = after.members.find(member => member.admission?.modelInteractionSeed || member.head.admission?.modelInteractionSeed);
      assert(continued, "The continued Child retains its scoped seed admission");
      const request = requests.find(request => request.metadata.runId === continued.head.state.run.id);
      assert.equal(request.modelContext.assessment.measurement.status, "unknown", "The first continued Child input cannot import another Run's accepted usage");
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
        const step = records.find(record => record.payload.kind === "flow_step" && record.payload.observation.kind === "step_entered" &&
          record.payload.observation.definition.id === "model-activity-access" && record.payload.observation.stepId === "binding");
        assert(step);
        const fact = step.payload.observation;
        const detail = await query.query({...selection, kind: "get_flow_occurrence", runId: fact.runId,
          invocationId: fact.invocationId, occurrenceId: fact.stepExecutionId});
        assert(detail.flow.occurrence.references.some(ref => ref.role === "output" && ref.availability === "present" &&
          ref.reference.kind === "model_activity"), "Activity material must resolve through the Inspector query path");
        assert(records.some(record => record.payload.kind === "recording_link" && record.payload.target?.datasetId === "resume"));
        inspectionEvidence = {...selection, recordCount: records.length, modelActivityBindings: bindings.length, resolvedActivity: true};
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
  await activityHost.service.close();
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
