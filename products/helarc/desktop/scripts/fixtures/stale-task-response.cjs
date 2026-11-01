const {app} = require("electron");
const assert = require("node:assert/strict");
const {join} = require("node:path");
const {pathToFileURL} = require("node:url");
const {writeFile, readFile} = require("node:fs/promises");
const [directory, phase] = process.argv.slice(2);
const failedTurn=process.env.ACTIVITY_FAILED_TASK==="1";
app.setPath("userData", join(directory, "electron"));
app.disableHardwareAcceleration();
let store;
async function main() {
  await app.whenReady();
  const {HelarcExecutionStore} = await import(pathToFileURL(join(__dirname, "../../dist/main/execution-storage/HelarcExecutionStore.js")));
  const {RunExecutionCoordinator} = await import("@agent-anything/agent-runtime/execution-coordinator");
  const {createControllerModelItems, createControllerInputDeliveryReceipt, projectModelInteraction, TaskDecisionActivityError} = await import("@agent-anything/agent-runtime/decision");
  const {createAgentInstructions} = await import("@agent-anything/agent-core/agent");
  const {createOperationDefinitionCatalog} = await import("@agent-anything/operation-catalog/catalog");
  const {createOperationBindingResolverSnapshot} = await import("@agent-anything/operation-catalog/binding");
  const {createOperationResultContracts} = await import("@agent-anything/operation-catalog/result");
  const {createToolRegistrationSnapshot} = await import("@agent-anything/tools/registration");
  const {createFixedLocalToolSelection} = await import("@agent-anything/tools/selection");
  const {createInteractionProtocolRegistrySnapshot} = await import("@agent-anything/interaction/coordination");
  const {resolvePermissionProfile} = await import("@agent-anything/permission");
  const {createModelCallRef} = await import("@agent-anything/model-interaction");
  const {createTestContextProjection} = await import("@agent-anything/test-support");
  store = await HelarcExecutionStore.open(join(directory, "execution"));
  const catalog = createOperationDefinitionCatalog({id: "empty", revision: "1", entries: []});
  const operations = {catalog, bindings: createOperationBindingResolverSnapshot("empty", []),
    toolInputSemanticValidators: [], resultContracts: createOperationResultContracts(catalog, []), internalHandlers: [], availability: []};
  const agent = {id: "fixture", revision: "1", name: "Fixture", metadata: {},
    instructions: createAgentInstructions({id: "fixture-instructions", release: {id: "fixture", revision: "1"},
      model: {providerId: "fixture", modelId: "fixture"}, resolverRevision: "1", blocks: []}),
    output: {validate: output => ({valid: true, output})}};
  const managedConstraints = {constraintSetId: "fixture", selectableProfiles: {allowedProfileIds: null, deniedProfileIds: []},
    fileSystem: [], network: {enabled: null, allowedDomains: [], deniedDomains: []}, allowUnenforcedExecution: true};
  const retry = {maxRetries: 0, delay: {kind: "exponential_jitter", baseDelayMs: 0, maxDelayMs: 0, multiplier: 2, jitterRatio: 0.1},
    retryableCategories: [], serverDelay: {mode: "ignore"}};
  const config = {workspace: {primary: {id: "workspace", name: "Fixture", rootRef: directory, trustState: "trusted", source: "test", policyRefs: [], metadata: {}}, additional: []},
    identity: {id: "fixture", kind: "user", displayName: "Fixture", metadata: {}},
    permissions: {permissionProfile: resolvePermissionProfile({profileId: ":read-only", profiles: [],
      environment: {environmentId: "fixture", platform: "win32", workspaceRoots: [{rootId: "workspace", path: directory}]}, managedConstraints}),
      approvalPolicy: "never", reviewer: null, rules: [], networkRules: [], managedConstraints, sessionAuthority: null,
      persistentPolicyAmendments: null, authorityApplicationLimits: {commitTimeoutMs: 1000}},
    tools: createFixedLocalToolSelection(createToolRegistrationSnapshot(catalog, []), catalog, []), actionExecution: null,
    limits: {maxIterations: 8, maxActions: 8, maxConsecutiveActionFailures: 3, maxDurationMs: 300000, maxPendingInteractions: 4,
      plan: {maxSteps: 8, maxStepLength: 200, maxExplanationLength: 500}},
    runTreeLimits: {maxTotalDescendantRuns: 0, maxActiveDescendantRuns: 0, maxDescendantDepth: 0},
    runTreeResources: Object.fromEntries(["controllerTurns", "actions", "modelInputTokens", "modelOutputTokens", "costUnits", "contextBytes", "resultBytes"]
      .map(key => [key, {maximum: key === "controllerTurns" || key === "actions" ? 32 : 8000000, minimumChildGrant: 1, enforcement: "hard"}])),
    runTreeApprovals: {maxTotalRequests: 4, maxRequestsPerOperationFingerprint: 2, maxConsecutiveDeclines: 2, maxConsecutiveReviewerFailures: 2, maxActiveReviews: 2},
    audit: "optional", telemetry: "optional", cancellationLimits: {operationSettlementTimeoutMs: 1000, processGracePeriodMs: 100,
      processForceKillTimeoutMs: 500, finalizationTimeoutMs: 1000}, retry: {providerRequest: retry, structuredOutput: retry, action: {maxAttempts: 1}}, metadata: {}};
  const now = () => new Date().toISOString();
  const fact = {runId: "root", sequence: 1, occurredAt: "2026-10-30T00:00:00Z",
    source: {owner: "fixture", kind: "finding", id: "original-fact", revision: "1"}, data: {value: "retained"}};
  let handle, calls = 0;
  const taskDecisions = {resourceMetering: {modelInputTokens: "not_applicable", modelOutputTokens: "not_applicable", costUnits: "not_applicable"},
    async next(input) {
      calls++;
      assert(!failedTurn||phase==="seed","Recovery must finish the original failure, not request another decision");
      assert.equal(calls, 1, "A process must not repeat this task decision");
      const requestId = `request-${phase}`, turnId = `turn-${phase}`;
      let content = [{kind: "text", text: "Original response retained despite changed task basis."}], candidates = [];
      let completionSource = {kind: "controller"};
      if (phase === "seed") {
        const plan = {plan: [{step: "This stale Plan must never be applied", status: "completed"}]};
        const calls = ["update_plan", "final_result"].map((name, index) => ({name, input: name === "update_plan" ? plan : {response: "Stale ending"},
          modelCallRef: createModelCallRef({providerRequestId: requestId, controllerRequestId: input.toolExposure.controllerRequestId,
            turnId, contentBlockOrdinal: index + 1, branchId: input.toolExposure.controllerRequestId}),
          providerCallRef: {providerId: "fixture", id: `${requestId}:${index}`}, ordinal: index + 1}));
        content.push(...calls.map(call => ({kind: "model_tool_call", call})));
        candidates = [{kind: "state_transition", transition: "plan_update", input: plan, modelCallRef: calls[0].modelCallRef}];
        completionSource = {kind: "model_call", modelCallRef: calls[1].modelCallRef};
        if(!failedTurn){const receipt = await handle.steer({commandId: "new-basis", expectedRunRevision: handle.getSnapshot().runRevision,
          instruction: "Use the changed objective; do not apply the old proposed Plan.", attribution: {origin: "user", actorId: "fixture"}, submittedAt: now()});
        assert.equal(receipt.status, "accepted_for_application");
        }
      } else {
        assert.equal(input.plan, null);
        assert.deepEqual(input.interaction.messages.map(message => message.role), ["assistant", "tool"]);
        assert.equal(input.interaction.unsettledCalls.length, 0);
        const results = input.interaction.messages[1].content.map(block => block.result);
        assert.deepEqual(results.map(result => result.settlement), ["invalidated", "invalidated"]);
        assert.equal(input.inputDelivery.entries.filter(entry => entry.source.id === "original-fact").length, 0);
      }
      const proposal={kind: "propose_completion", candidates, completionSource, output: {summary: phase === "seed" ? "Stale ending" : "Fresh ending"},
        modelItems: createControllerModelItems({turnId, assistant: {role: "assistant", content}, finish: {kind: "normal"}, usage: null,
          responseRef: {providerId: "fixture", requestId, responseId: `response-${phase}`}}),
        ...(input.inputDelivery ? {inputDeliveryReceipt: createControllerInputDeliveryReceipt(input.inputDelivery, input.toolExposure.controllerRequestId)} : {})};
      if(failedTurn)throw new TaskDecisionActivityError({kind:"model",failure:{code:"model_output_invalid",message:"No usable original decision",retryable:false,metadata:{}}},
        "settled_failure",null,{exchange:{modelItems:proposal.modelItems,inputDeliveryReceipt:proposal.inputDeliveryReceipt}});
      return proposal;
    }};
  const recorded = [];
  const runner = new RunExecutionCoordinator({taskDecisions, operations, contextProjection: createTestContextProjection(), createRunId: () => "root", now,
    runTreeCommits: store, interactions: createInteractionProtocolRegistrySnapshot("empty", []),
    inputNotifications: {read: (_run, cursor) => cursor < 1 ? [fact] : []}, runTranscriptObserver: {observe: record => recorded.push(record)}});
  if (phase === "seed") {
    const commit = store.commitRunTree.bind(store);
    store.commitRunTree = async value => {
      const receipt = await commit(value);
      if (value.runs.some(run => run.state.items.some(item => item.payload.kind === "controller_turn" && item.payload.status === (failedTurn?"failed":"interrupted")))) {
        await writeFile(join(directory, "seed.json"), JSON.stringify(await store.readRunTree("root")));
        app.exit(73);
        await new Promise(() => {});
      }
      return receipt;
    };
    handle = runner.start(agent, {task: {id: "task", kind: "fixture", input: {}, createdAt: now(), metadata: {}},
      items: [{id: "assignment", kind: "message", role: "user", content: "Inspect without effects.", createdAt: now(), metadata: {}}], metadata: {}}, config);
    await handle.wait();
    throw new Error("Interruption boundary not reached");
  }
  const before = await store.readRunTree("root");
  if (phase === "resume") {
    assert.deepEqual(before, JSON.parse(await readFile(join(directory, "seed.json"), "utf8")));
    handle = await runner.recover("root", {async resolve() {return {agent, config};}});
    const result = await handle.wait();
    assert.equal(result.status, failedTurn?"failed":"completed", JSON.stringify(result.cause));
    if(failedTurn)assert.equal(result.cause.failure.failure.code,"model_output_invalid");
    else {assert.equal(result.finalOutput.summary,"Fresh ending");assert(recorded.some(record=>record.item.payload.kind==="controller_turn"));}
    assert.equal(calls, failedTurn?0:1);
  }
  const tree = await store.readRunTree("root"), state = tree.members[0].head.state;
  assert.equal(state.status, failedTurn?"failed":"completed");
  assert.equal(state.counters.runActions, 0);
  assert.equal(state.items.filter(item => item.payload.kind === "model_call_settlement").length, 2);
  assert.equal(state.items.flatMap(item => item.payload.kind === "input_delivery" ? item.payload.batch.entries : []).filter(entry => entry.source.id === "original-fact").length, 1);
  const projection = projectModelInteraction({runId: "root", runRevision: state.revision, items: state.items});
  assert.deepEqual(projection.messages.map(message => message.role), failedTurn?["assistant","tool"]:["assistant", "tool", "assistant"]);
  assert.equal(projection.unsettledCalls.length, 0);
  if (phase === "resume") await writeFile(join(directory, "verification.json"), JSON.stringify({electron: process.versions.electron,
    originalExchangeRetained: true, failedTurn, invalidatedCalls: 2, effects: 0, repeatedDeliveries: 0, taskDecisionCallsAfterRestart: calls}));
  await store.close(); store = null; app.exit(0);
}
main().catch(async error => {console.error(error); try {await store?.close();} finally {app.exit(1);}});
