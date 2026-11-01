import {describe, expect, it, vi} from "vitest";
import {createModelCallRef, createNativeToolTurnInteraction, snapshotModelCallableRequest, snapshotModelToolResult,
  snapshotProviderRequest, type ModelTurn, type ProviderResponse, type ProviderRequest} from "@agent-anything/model-interaction";
import {allocateInputCapacity, assessInputCapacity, assertEncodedModelInputIntegrity, composeInputChoice, composeModelInput, createEncodedModelInput,
  declareModelResultTextSlot, fillModelResultTextSlot, modelInputSectionLocations, modelInputValueDigest, nextInputCombination,
  recordInputCombination, startInputCombinationSearch, type InputOrganizationDemand, type ModelInputResultTextBinding,
  type ModelInputSectionCandidate, type ModelToolMessage} from "@agent-anything/model-interaction/input";
import type {ContextSelectionSnapshot} from "@agent-anything/context/selection";
import type {ActivityHandoffPort, ActivityPathState, ActivityStageState} from "../activity/ActivityHandoff.js";
import type {ActivityPurposeHandler} from "../activity/ActivityHandoffProcessor.js";
import {validatePreparedContextInput, type PreparedContextInput} from "../context-representation/ContextInputPreparation.js";
import {acceptedConversationRepresentationContinuity} from "../context-representation/ContextPreparationEvidence.js";
import type {RunItem} from "../run/RunItem.js";
import type {TaskDecisionInputSources} from "./TaskDecisionActivity.js";
import {createControllerModelItems} from "./TaskDecisionModelItems.js";
import {retainTaskDecisionSource} from "./TaskDecisionSourceRecord.js";
import {snapshotTaskModelExchange, validateTaskDecisionProposal} from "./TaskDecisionValidation.js";
import {projectModelInteraction} from "./ModelInteractionProjection.js";
import {canonicalConversationPresentations, createModelConversationSeed} from "./TaskConversation.js";
import {createInputDeliverySections, createProviderInputDeliveryReceipt, type ControllerInputDeliveryBatch} from "./DecisionInputDelivery.js";
import {TASK_MODEL_RESPONSE_PURPOSE, TaskModelResponsePath, type TaskModelSource, type TaskModelResponseProgress} from "./TaskModelResponsePath.js";
import {createTaskModelResponseHandoff, readTaskModelResponseHandoff} from "./TaskModelResponseHandoff.js";
import {applySelectedResultPresentations, createSelectedResultPresentationReceipt, snapshotSelectedResultPresentationReceipt,
  validateSelectedResultPresentationInput, type SelectedResultPresentationReceipt} from "./SelectedResultPresentation.js";

const now = "2026-10-31T00:00:00.000Z", runId = "run-1", controllerRequestId = "turn-2:controller";
const derived = "Derived representation of this result's report; the original result is retained.\nChecked details.";
const ref = {owner: "test", kind: "binding", id: "binding", revision: "1"};
const target = {providerId: "provider-1", model: "m", revision: "1"};
const interaction = createNativeToolTurnInteraction([{name: "agent_child", description: "Delegate inspection", inputSchema: {type: "object"}}]);
const lineage = {instructionBinding: ref, agent: ref, instructions: ref, instructionRelease: ref, instructionResolver: ref,
  instructionContent: ref, instructionModel: {providerId: target.providerId, model: target.model}, instructionBlocks: [], activeContext: null, contextProjection: null,
  projectionManifest: null, toolSelection: null, toolExposureContent: null, toolExposureBasis: null, toolExposureProof: null,
  toolGuidance: null, controllerControlGuidance: null, callableDefinitions: null, modelQualification: null,
  interactionHistory: null, protocol: ref, policy: ref};
const compositionTarget = {providerId: target.providerId, model: target.model, interaction, lineage, composedAt: now};
function request(composition: ProviderRequest["composition"]): ProviderRequest {
  return snapshotProviderRequest({requestId: composition.id, purpose: "task", correlation: {controllerRequestId, branchId: `${runId}:main`},
    composition, instructions: composition.instructions, messages: composition.messages, interaction, continuation: null, metadata: {},
    modelContext: {assessment: null, requestedOutput: {unit: "tokens", maximum: 100, source: "host_configured", revision: "1"},
      headroom: {unit: "tokens", amount: 0, policy: {id: "test", revision: "1"}}}});
}
function prepare(sections: readonly ModelInputSectionCandidate[], bindings: readonly ModelInputResultTextBinding[], unchosen: readonly ModelInputResultTextBinding[] = []): PreparedContextInput {
  let demand: InputOrganizationDemand = {id: "input-demand", runId, recipient: "agent", purpose: "task", targetRevision: modelInputValueDigest(target),
    historyBoundary: "history-3", deliveryIds: [], dependencies: {}, maximumCombinations: 1, maximumExternalMeasurements: 0, maximumReadBytes: 0,
    contributions: [{id: "native-group", owner: "test", sourceRevision: "1", deliveryIds: [], currentOptionId: "derived",
      localBudget: {dimension: "input_tokens", grant: null, ceiling: null}, options: [{id: "derived", revision: "1", duties: ["continuity", "new_information"],
        sections: sections.map((section, position) => ({position, section})), resultTextBindings: bindings, findings: [], requirements: [],
        requires: [], excludes: [], preference: 0, estimatedCost: null, omissionBasis: null}]}]};
  if (unchosen.length) demand = {...demand, contributions: demand.contributions.map(contribution => ({...contribution,
    options: [...contribution.options, {...contribution.options[0]!, id: "not-selected", resultTextBindings: unchosen}]}))};
  const step = nextInputCombination(demand, startInputCombinationSearch(demand));
  if (step.kind !== "measure") throw new Error("Expected a candidate");
  const composed = composeInputChoice(demand, step.choice, compositionTarget), actual = request(composed);
  const encoded = createEncodedModelInput({request: actual, target, adapterRevision: "test:1", endpoint: "test", mode: "buffered", body: JSON.stringify(actual.messages)});
  const measurement = [{id: "bytes", encodedInputId: encoded.id, targetRevision: demand.targetRevision, methodRevision: "utf8:1",
    dimension: "request_bytes" as const, coverage: "complete" as const, quantity: {kind: "exact" as const, value: encoded.bytes}, basis: "actual bytes", uncovered: []}];
  const limits = [{id: "limit", targetRevision: demand.targetRevision, dimension: "request_bytes" as const, maximum: 1_000_000, source: "test"}];
  const capacity = assessInputCapacity({encodedInputId: encoded.id, targetRevision: demand.targetRevision, purpose: "task", limits,
    evidence: measurement, reservations: [], policy: {id: "test", revision: "1", purpose: "task", basis: "exact bytes", allowEstimatedFit: false, allowUnknown: false}});
  const prepared: PreparedContextInput = {kind: "prepared_context_input", preparationStageId: "preparation:1", demand, choice: step.choice,
    request: actual, encoded, measurement, limits, capacity, progress: recordInputCombination(demand, step.progress, step.id, capacity),
    locations: modelInputSectionLocations(composed.sections), deliveries: [], allocation: allocateInputCapacity(demand, step.choice, [], null),
    localMeasurements: [], sharedCapacity: null};
  validatePreparedContextInput(prepared);
  return prepared;
}
function turn(id: string, requestId: string, content: ModelTurn["assistant"]["content"]): ModelTurn {
  return {turnId: id, assistant: {role: "assistant", content}, finish: {kind: "normal"}, usage: null,
    responseRef: {providerId: target.providerId, requestId, responseId: `${id}:response`}};
}
function controller(value: ModelTurn, receipt?: SelectedResultPresentationReceipt): Extract<RunItem["payload"], {kind: "controller_turn"}> {
  return {kind: "controller_turn", turn: {run: {id: runId}, id: `${value.turnId}:controller`, sequence: 1}, status: "decided", decisionKind: "advance",
    instructionBinding: {id: "instruction", revision: "1"}, toolExposure: {controllerRequestId} as never,
    modelItems: createControllerModelItems(value), failure: null, ...(receipt ? {resultPresentationReceipt: receipt} : {})};
}
function item(sequence: number, payload: RunItem["payload"]): RunItem {
  return {ref: {run: {id: runId}, id: `item-${sequence}`, sequence}, committedInRevision: sequence, createdAt: now, payload};
}
function fixture(notifications = false) {
  const calls = [0, 1].map(ordinal => snapshotModelCallableRequest({modelCallRef: createModelCallRef({providerRequestId: "request-1",
    controllerRequestId: "turn-1:controller", turnId: "turn-1", contentBlockOrdinal: ordinal, branchId: `${runId}:main`}),
    providerCallRef: {providerId: target.providerId, id: `provider-call-${ordinal}`}, name: ordinal ? "sibling" : "agent_child", ordinal, input: {task: "inspect"}}));
  const results = calls.map(call => snapshotModelToolResult({modelCallRef: call.modelCallRef, providerCallRef: call.providerCallRef, name: call.name,
    settlement: call.ordinal ? "succeeded" : "failed", presentation: {presenter: {id: "test", revision: "1"}, disposition: "complete", failureCode: null},
    content: {report: call.ordinal ? "Sibling report" : "Original large report. ".repeat(400), detail: ["Original appendix"],
      status: call.ordinal ? "succeeded" : "failed", effects: [{kind: "partial", path: "result.txt"}], failure: {code: "budget_exhausted"},
      limits: {steps: 5}, correlation: {childRunId: "child", requestId: "delegation"}}, sourceRefs: [ref]}));
  const items = [item(1, controller(turn("turn-1", "request-1", calls.map(call => ({kind: "model_tool_call", call}))))),
    ...results.map((result, index) => item(index + 2, {kind: "model_call_settlement", result}))];
  const projection = projectModelInteraction({runId, runRevision: 3, items});
  const sections = projection.historyPresentations!.map(value => value.section);
  const message = projection.messages[1] as ModelToolMessage;
  const declaration: ModelInputResultTextBinding = {sectionId: sections[1]!.id, slot: declareModelResultTextSlot(message, calls[0]!.modelCallRef.id, ["report"]),
    source: {owner: "agent-runtime", kind: "result_text_declaration", id: "declared-body", revision: null},
    representation: {owner: "context-representation", kind: "representation", id: "representation", revision: "2"}};
  const batch: ControllerInputDeliveryBatch = {id: "notifications", revision: "1", runId, entries: [{sequence: 1, runId, source: ref,
    occurredAt: now, data: {message: "Later update"}}]};
  const extra = notifications ? createInputDeliverySections(batch) : [];
  const originalRequest = request(composeModelInput({...compositionTarget, id: "original-request", sections: [...sections, ...extra]}));
  const actual = sections.map(section => section.id === declaration.sectionId ? {...section,
    content: {kind: "model_message" as const, message: fillModelResultTextSlot(message, declaration.slot, derived)}} : section);
  const prepared = prepare([...actual, ...extra], [declaration]);
  const binding = {acceptanceId: "input-acceptance", scope: {id: "scope", runId, recipient: "agent", purpose: "task", target: prepared.demand.targetRevision},
    selection: {id: "selection", representations: [{id: "representation", revision: "2"}], judgmentIds: ["joint-judgment"], holds: []},
    input: {id: "task:model:input", activityId: "task", stageRequestId: "task:model", scopeId: "scope", selectionId: "selection", exactInput: prepared,
      target: prepared.demand.targetRevision, deliveries: [], holds: [], combinationJudgmentId: "joint-judgment"}, deliveries: []} as unknown as ContextSelectionSnapshot;
  const response: Extract<ProviderResponse, {kind: "native_tool_turn"}> = {kind: "native_tool_turn", continuation: null, metadata: {},
    turn: turn("turn-2", prepared.request.requestId, [{kind: "text", text: "Accepted result."}])};
  const create = (selected = binding, output: ProviderResponse = response) => createSelectedResultPresentationReceipt({originalRequest, binding: selected,
    response: output, rawResultId: "raw", responseAcceptanceId: "response-acceptance"})!;
  const receipt = create();
  return {calls, results, items, projection, sections, message, declaration, originalRequest, actual, prepared, binding, response, create, receipt, batch};
}
function rehash(value: SelectedResultPresentationReceipt): SelectedResultPresentationReceipt {
  const {digest: _, ...body} = value;
  return {...body, digest: modelInputValueDigest(body)};
}

describe("accepted native result presentation", () => {
  it("binds the original, chosen declaration, encoded request, selection judgment, raw and acceptance", () => {
    const f = fixture();
    expect(f.receipt).toMatchObject({originalRequestId: f.originalRequest.requestId, requestId: f.prepared.request.requestId,
      encodedInputId: f.prepared.encoded.id, inputId: "task:model:input", selectionId: "selection", combinationJudgmentId: "joint-judgment",
      inputAcceptanceId: "input-acceptance", responseAcceptanceId: "response-acceptance", rawResultId: "raw"});
    expect(f.receipt.presentations[0]!.bindings).toEqual([f.declaration]);
    expect(f.receipt.presentations[0]!.message.content[1]).toEqual(f.message.content[1]);
    expect(JSON.parse(f.prepared.encoded.body)[1].content[0].result.content.report).toBe(derived);
    expect(f.message.content[0]!.result.content).not.toEqual(f.receipt.presentations[0]!.message.content[0]!.result.content);
    expect(snapshotSelectedResultPresentationReceipt(JSON.parse(JSON.stringify(f.receipt)))).toEqual(f.receipt);
  });
  it.each(["selection", "judgment", "response", "encoded", "undeclared", "slot"])("rejects changed %s before accepting", changed => {
    const f = fixture();
    if (changed === "selection") expect(() => f.create({...f.binding, selection: {...f.binding.selection, representations: []}})).toThrow("not_selected");
    if (changed === "judgment") expect(() => f.create({...f.binding, selection: {...f.binding.selection, judgmentIds: []}})).toThrow("binding_invalid");
    if (changed === "response") expect(() => f.create(f.binding, {...f.response, turn: {...f.response.turn,
      responseRef: {...f.response.turn.responseRef, requestId: "other"}}})).toThrow("binding_invalid");
    if (changed === "encoded") expect(() => f.create({...f.binding, input: {...f.binding.input,
      exactInput: {...f.prepared, encoded: {...f.prepared.encoded, body: "different"}}}})).toThrow("encoded_model_input_binding_changed");
    if (changed === "undeclared" || changed === "slot") {
      const next = prepare(f.actual, changed === "undeclared" ? [] : [{...f.declaration, slot: {...f.declaration.slot, textDigest: "different"}}]);
      expect(() => f.create({...f.binding, input: {...f.binding.input, exactInput: next}}, {...f.response,
        turn: {...f.response.turn, responseRef: {...f.response.turn.responseRef, requestId: next.request.requestId}}})).toThrow();
    }
  });
  it("does not use declarations on unchosen options or create receipts for untouched original input", () => {
    const f = fixture(), prepared = prepare(f.sections, [], [f.declaration]);
    expect(prepared.demand.contributions[0]!.options[1]!.resultTextBindings).toHaveLength(1);
    expect(f.create({...f.binding, input: {...f.binding.input, exactInput: prepared}}, {...f.response,
      turn: {...f.response.turn, responseRef: {...f.response.turn.responseRef, requestId: prepared.request.requestId}}})).toBeNull();
  });
  it.each(["status", "effects", "failure", "limits", "correlation", "name", "providerCallRef", "sourceRefs", "sibling"])("rejects a rehashed presentation changing %s outside the declared body", changed => {
    const f = fixture(), message = structuredClone(f.receipt.presentations[0]!.message), first = message.content[0]!.result;
    if (["status", "effects", "failure", "limits", "correlation"].includes(changed)) Object.assign(first.content as object, {[changed]: "forged"});
    else if (changed === "sibling") Object.assign(message.content[1]!.result.content as object, {report: "forged"});
    else Object.assign(first, {[changed]: changed === "providerCallRef" ? {providerId: target.providerId, id: "other"} : changed === "sourceRefs" ? [] : "other"});
    const receipt = rehash({...f.receipt, presentations: [{...f.receipt.presentations[0]!, message}]});
    expect(() => applySelectedResultPresentations(receipt, f.sections, runId, receipt.requestId, controllerRequestId)).toThrow();
  });
  it("supports two disjoint body leaves while rejecting duplicate declarations", () => {
    const f = fixture(), appendix = {...f.declaration, slot: declareModelResultTextSlot(f.message, f.calls[0]!.modelCallRef.id, ["detail", 0])};
    const first = fillModelResultTextSlot(f.message, f.declaration.slot, derived);
    const message = fillModelResultTextSlot(first, declareModelResultTextSlot(first, appendix.slot.callId, appendix.slot.contentPath), "Derived appendix");
    const prepared = prepare(f.sections.map(section => section.id === f.declaration.sectionId ? {...section, content: {kind: "model_message", message}} : section), [f.declaration, appendix]);
    const receipt = f.create({...f.binding, input: {...f.binding.input, exactInput: prepared}}, {...f.response,
      turn: {...f.response.turn, responseRef: {...f.response.turn.responseRef, requestId: prepared.request.requestId}}});
    expect(applySelectedResultPresentations(receipt, f.sections, runId, receipt.requestId, controllerRequestId)[1]!.content).toEqual({kind: "model_message", message});
    expect(() => snapshotSelectedResultPresentationReceipt(rehash({...receipt, presentations: [{...receipt.presentations[0]!, bindings: [f.declaration, f.declaration]}]}))).toThrow("overlapping_declarations");
  });
  it.each(["decided", "interrupted", "failed"] as const)("replays actual presentation through three later turns after %s, without changing original settlements", status => {
    const f = fixture(), originalItems = JSON.stringify(f.items);
    expect(f.projection.messages[1]).toEqual(f.message);
    expect(acceptedConversationRepresentationContinuity(f.projection)).toBe("original");
    let continuity: string | null = null;
    const items = [...f.items, item(4, {...controller(f.response.turn, f.receipt), status})];
    for (let round = 0; round <= 3; round++) {
      const projected = projectModelInteraction({runId, runRevision: items.length, items: JSON.parse(JSON.stringify(items))});
      const actualContinuity = acceptedConversationRepresentationContinuity(projected);
      expect(actualContinuity).toMatch(/^accepted-representations:/);
      if (continuity !== null) expect(actualContinuity).toBe(continuity);
      continuity = actualContinuity;
      expect(projected.messages[1]).toEqual(f.receipt.presentations[0]!.message);
      expect(projected.messages.filter(message => message.role === "tool")).toHaveLength(1);
      expect(projected.historyPresentations![1]!.section.content).toEqual({kind: "model_message", message: projected.messages[1]});
      expect(projected.historyPresentations![1]!.section.provenance).toMatchObject({author: "capability",
        presenter: {kind: "result_presentation_receipt", id: f.receipt.digest}, sources: expect.arrayContaining([f.declaration.source, f.declaration.representation])});
      const nextRequest = request(composeModelInput({...compositionTarget, id: `next-${round}`, sections: canonicalConversationPresentations(projected).map(value => value.section)}));
      expect(nextRequest.messages[1]).toEqual(f.receipt.presentations[0]!.message);
      const seed = createModelConversationSeed(runId, String(items.length), canonicalConversationPresentations(projected));
      expect(seed.presentations[1]!.section.content).toEqual({kind: "model_message", message: projected.messages[1]});
      items.push(item(items.length + 1, controller(turn(`later-${round}`, nextRequest.requestId, [{kind: "text", text: `Round ${round}`}]))));
    }
    expect(JSON.stringify(f.items)).toBe(originalItems);
  });
  it("applies at the original result position after notification flushing, without duplicating or moving delivery", () => {
    const f = fixture(true), accepted = item(5, controller(f.response.turn, f.receipt));
    const delivery = {...item(4, {kind: "input_delivery", batch: f.batch, receipt: createProviderInputDeliveryReceipt(f.batch, f.prepared.request)!,
      turn: accepted.payload.kind === "controller_turn" ? accepted.payload.turn : null!}), committedInRevision: 5};
    const projection = projectModelInteraction({runId, runRevision: 5, items: [...f.items, delivery, accepted]});
    expect(projection.messages.map(value => value.role)).toEqual(["assistant", "tool", "user", "assistant"]);
    expect(projection.messages[1]).toEqual(f.receipt.presentations[0]!.message);
    expect(projection.notificationHistory).toHaveLength(1);
  });
  it("validates the source exchange and projector instead of accepting a checksum alone", () => {
    const f = fixture(), source = {runId, agent: {id: "agent"}, interaction: f.projection, toolExposure: {controllerRequestId}, inputDelivery: null} as unknown as TaskDecisionInputSources;
    const exchange = {modelItems: createControllerModelItems(f.response.turn), resultPresentationReceipt: f.receipt};
    expect(snapshotTaskModelExchange(exchange, source).resultPresentationReceipt).toEqual(f.receipt);
    const wrong = rehash({...f.receipt, requestId: "other"});
    expect(() => snapshotTaskModelExchange({...exchange, resultPresentationReceipt: wrong}, source)).toThrow();
    expect(() => projectModelInteraction({runId, runRevision: 4, items: [...f.items, item(4, controller(f.response.turn, wrong))]})).toThrow();
    const anotherResponse = {...f.response.turn, assistant: {role: "assistant" as const, content: [{kind: "text" as const, text: "Different response to the same request"}]}};
    expect(() => snapshotTaskModelExchange({modelItems: createControllerModelItems(anotherResponse), resultPresentationReceipt: f.receipt}, source)).toThrow("response_changed");
    expect(() => projectModelInteraction({runId, runRevision: 4, items: [...f.items, item(4, controller(anotherResponse, f.receipt))]})).toThrow("response_changed");
    const changed = structuredClone(f.items);
    if (changed[1]!.payload.kind === "model_call_settlement") Object.assign(changed[1]!.payload.result.content as object, {status: "changed"});
    expect(() => projectModelInteraction({runId, runRevision: 4, items: [...changed, item(4, controller(f.response.turn, f.receipt))]})).toThrow();
  });
  it.each(["rawResultId", "responseAcceptanceId", "originalRequestDigest", "encodedInputId"] as const)("recovery rechecks %s against original retained work", field => {
    const f = fixture(), receipt = rehash({...f.receipt, [field]: "changed"});
    expect(() => validateSelectedResultPresentationInput(receipt, f.originalRequest, f.prepared, "raw", "response-acceptance")).toThrow("accepted_input_changed");
  });
});

function responsePathFixture(authorize:ActivityPurposeHandler["authorize"]=async()=>({kind:"allowed"})) {
  const f = fixture(), agent = {id: "agent", revision: "1", output: {validate: (output: unknown) => ({valid: true, output})}};
  const source = {runId, agent, interaction: f.projection, inputDelivery: null, toolExposure: {controllerRequestId}} as unknown as TaskDecisionInputSources;
  const original: TaskModelSource = {kind: "task_model_source", record: retainTaskDecisionSource(source), request: f.originalRequest, protocol: {kind: "native_tool_turn"}};
  const path = {intent: {id: "task", runId, owner: "task-decision", purpose: {contract: TASK_MODEL_RESPONSE_PURPOSE, digest: modelInputValueDigest(TASK_MODEL_RESPONSE_PURPOSE)}},
    controlRevision: 0, cancelled: false} as ActivityPathState;
  const sourceStage = {request: {id: "task:source", pathId: "task", stageKind: "source", input: original}, status: "accepted"} as ActivityStageState;
  const stage = {request: {id: "task:model", pathId: "task", stageKind: "model", input: f.prepared}, status: "raw_result",
    result: {id: "raw", completeness: "complete", outcome: "returned", value: {kind: "succeeded", response: f.response}}} as ActivityStageState;
  const activities: ActivityHandoffPort = {command: vi.fn(async command => {
    if(command.kind==="read_path")return path;
    if(command.kind==="read_input_need"&&command.id==="task:input-need")return {id:command.id,supplier:TASK_MODEL_RESPONSE_PURPOSE.inputOwner,
      stage:{id:"task:model",pathId:"task"},unavailableStage:{id:"task:input-unavailable",pathId:"task"}};
    if(command.kind==="read_stage")return command.requestId==="task:source"?sourceStage:command.requestId==="task:model"?stage:null;
    throw new Error(`Result observation cannot dispatch work: ${command.kind}`);
  })};
  const selections = {command: vi.fn(async () => f.binding)};
  const interpret = vi.fn(async () => ({kind: "propose_completion" as const, completionSource: {kind: "controller" as const}, candidates: [],
    output: {summary: "Done"}, modelItems: createControllerModelItems(f.response.turn)}));
  const provider = {verifyEncodedInput: vi.fn((request: ProviderRequest, encoded: PreparedContextInput["encoded"]) => assertEncodedModelInputIntegrity(encoded, request)),
    send: vi.fn(async () => ({kind: "succeeded", response: f.response}))};
  const handler = new TaskModelResponsePath({provider: provider as never, activities, selections: selections as never, authorize,
    resolveAgent: () => agent as never, interpret, now: () => now});
  return {...f, source, original, path, stage, sourceStage, activities, selections, interpret, provider, handler};
}
describe("Task response native result acceptance", () => {
  it.each(["allowed","temporary","denied"] as const)("preserves %s through task and prepared-input authorization for every action",async kind=>{
    const result=kind==="allowed"?{kind}:kind==="temporary"?{kind,code:"pending",message:"Await authority"}:
      {kind,code:"denied",message:"Authority revoked",decision:{owner:"host",id:"denial",revision:"1"}};
    const authorize=vi.fn<ActivityPurposeHandler["authorize"]>(async()=>result),f=responsePathFixture(authorize),signal=new AbortController().signal;
    for(const stage of [f.sourceStage,f.stage])for(const action of ["admission","execution","reconciliation","interpretation","settlement"] as const) {
      expect(await f.handler.authorize(f.path,stage,signal,action)).toBe(result);
      expect(authorize).toHaveBeenLastCalledWith(f.path,stage,signal,action);
    }
    expect(authorize).toHaveBeenCalledTimes(10);expect(f.provider.send).not.toHaveBeenCalled();
    expect(f.interpret).not.toHaveBeenCalled();expect(f.provider.verifyEncodedInput).toHaveBeenCalledTimes(5);
    expect(f.selections.command).toHaveBeenCalledWith({kind:"binding",inputId:"task:model:input",checkCurrentControl:false});
    expect(f.selections.command).toHaveBeenCalledWith({kind:"binding",inputId:"task:model:input",checkCurrentControl:true});
  });
  it("does not use permission to bypass the original prepared input binding",async()=>{
    const authorize=vi.fn<ActivityPurposeHandler["authorize"]>(async()=>({kind:"allowed"})),f=responsePathFixture(authorize);
    f.selections.command.mockResolvedValue({...f.binding,input:{...f.binding.input,stageRequestId:"another-stage"}});
    await expect(f.handler.authorize(f.path,f.stage,new AbortController().signal,"execution")).rejects.toThrow("dispatch_scope_invalid");
    expect(authorize).not.toHaveBeenCalled();expect(f.provider.send).not.toHaveBeenCalled();
  });
  it("sends the frozen actual native body before producing its acceptance receipt", async () => {
    const f = responsePathFixture();
    const raw = await f.handler.execute(f.path, f.stage, {id: "attempt"} as never, new AbortController().signal);
    expect(f.provider.send).toHaveBeenCalledWith(f.prepared.request, expect.anything(), expect.objectContaining({encodedInput: f.prepared.encoded}));
    expect(f.selections.command).toHaveBeenCalledWith({kind: "sent", inputId: "task:model:input", attemptId: "attempt"});
    expect(f.projection.messages[1]).toEqual(f.message);
    Object.assign(f.stage, {result: raw});
    const result = await f.handler.interpret(f.path, f.stage, new AbortController().signal, {id: "response-acceptance"});
    const progress = result.progress as TaskModelResponseProgress;
    expect(progress.exchange!.resultPresentationReceipt).toMatchObject({rawResultId: raw.id,
      presentations: [{message: f.receipt.presentations[0]!.message}]});
    expect(f.provider.send).toHaveBeenCalledTimes(1);
  });
  it("requires the selected exact input to equal the original model-stage input", async () => {
    const f = responsePathFixture();
    f.selections.command.mockResolvedValue({...f.binding, input: {...f.binding.input, exactInput: {...f.prepared, preparationStageId: "different"}}});
    await expect(f.handler.interpret(f.path, f.stage, new AbortController().signal, {id: "response-acceptance"})).rejects.toThrow("original_input_changed");
  });
  it.each(["requestId", "providerId"])("does not classify a known %s mismatch as merely unusable output", async field => {
    const f = responsePathFixture();
    const response = structuredClone(f.response);
    Object.assign(response.turn, {finish: {kind: "output_limit"}});
    Object.assign(response.turn.responseRef, {[field]: "other"});
    Object.assign(f.stage.result!, {value: {kind: "succeeded", response}});
    await expect(f.handler.interpret(f.path, f.stage, new AbortController().signal, {id: "response-acceptance"})).rejects.toThrow("mismatch");
    expect(f.interpret).not.toHaveBeenCalled();
  });
  it.each(["output_limit", "output_limit_malformed", "invalid_turn", "missing_turn", "duplicate_call"])("retains accepted input without promoting %s into conversation or Calls", async kind => {
    const f = responsePathFixture();
    const call = snapshotModelCallableRequest({...f.calls[0]!, modelCallRef: createModelCallRef({providerRequestId: f.prepared.request.requestId,
      controllerRequestId, turnId: f.response.turn.turnId, contentBlockOrdinal: 1, branchId: `${runId}:main`}), ordinal: 1});
    const rawResponse = structuredClone({...f.response, turn: {...f.response.turn, assistant: {role: "assistant", content: [
      {kind: "text", text: "REJECTED PARTIAL OUTPUT"}, {kind: "model_tool_call", call}]}, finish: {kind: kind.startsWith("output_limit") ? "output_limit" : "normal"}}});
    if (kind === "invalid_turn" || kind === "output_limit_malformed") Object.assign(rawResponse.turn.assistant, {content: [{kind: "text", text: 42}]});
    if (kind === "missing_turn") Object.assign(rawResponse, {turn: null});
    if (kind === "duplicate_call") rawResponse.turn.assistant.content.push({kind: "model_tool_call", call});
    Object.assign(f.stage.result!, {value: {kind: "succeeded", response: rawResponse}});
    const result = await f.handler.interpret(f.path, f.stage, new AbortController().signal, {id: "response-acceptance"});
    const progress = result.progress as TaskModelResponseProgress, exchange = progress.exchange!;
    expect(progress).toMatchObject({state: kind.startsWith("output_limit") ? "response_incomplete" : "response_not_usable", proposal: null});
    if (!kind.startsWith("output_limit")) expect(progress.failure).toMatchObject({kind: "model", failure: {code: "model_output_invalid"}});
    expect(exchange.modelItems).toEqual([]);
    expect(exchange.resultPresentationReceipt).toMatchObject({responseItemsDigest: null, responseRejectionDigest: exchange.responseRejection!.digest});
    expect(exchange.responseRejection).toMatchObject({reason: kind.startsWith("output_limit") ? "output_limit" : "invalid_turn", requestId: f.prepared.request.requestId,
      rawResultId: "raw", responseAcceptanceId: "response-acceptance"});
    expect(exchange.resultPresentationReceipt!.presentations).toEqual(f.receipt.presentations);
    expect(result.participants).toMatchObject([{owner: "context_delivery", kind: "accept", proposal: {inputId: "task:model:input", responseId: "raw"}}]);
    expect(f.projection.messages[1]).toEqual(f.message);
    expect(f.interpret).not.toHaveBeenCalled();
    const items = [...f.items, item(4, {...controller(f.response.turn), ...exchange, status: "failed"})];
    const projected = projectModelInteraction({runId, runRevision: 4, items: JSON.parse(JSON.stringify(items))});
    expect(projected.messages).toEqual([f.projection.messages[0], f.receipt.presentations[0]!.message]);
    expect(projected.unsettledCalls).toEqual([]);
    expect(projected.settledCallCount).toBe(2);
    expect(projected.latestTurn).toEqual(f.projection.latestTurn);
    const continuity = acceptedConversationRepresentationContinuity(projected);
    expect(continuity).toMatch(/^accepted-representations:/);
    expect(JSON.stringify(projected)).not.toContain("REJECTED PARTIAL OUTPUT");
    for (let round = 0; round < 3; round++) {
      const history = projectModelInteraction({runId, runRevision: items.length, items});
      expect(acceptedConversationRepresentationContinuity(history)).toBe(continuity);
      const next = request(composeModelInput({...compositionTarget, id: `correction-${round}`, sections: canonicalConversationPresentations(history).map(value => value.section)}));
      expect(next.messages[1]).toEqual(f.receipt.presentations[0]!.message);
      items.push(item(items.length + 1, controller(turn(`correction-${round}`, next.requestId, [{kind: "text", text: "Complete response"}]))));
    }
    expect(() => snapshotTaskModelExchange({...exchange, modelItems: createControllerModelItems(f.response.turn)}, f.source)).toThrowError(expect.objectContaining({failure:{code:"controller_response_rejection_binding_invalid",category:"structured_output_schema",correctionFeedback:expect.any(String)}}));
    expect(() => snapshotTaskModelExchange({...exchange, responseRejection: null}, f.source)).toThrow();
    expect(() => validateTaskDecisionProposal({...exchange, kind: "propose_completion", output: {}, candidates: [], completionSource: {kind: "controller"}}, f.source)).toThrowError(expect.objectContaining({failure:{code:"rejected_response_cannot_decide",category:"structured_output_schema",correctionFeedback:expect.any(String)}}));
    expect(validateTaskDecisionProposal({...exchange, kind: "continue_with_feedback", feedback: {source: ref, code: "retry_response", message: "Return a complete response."}}, f.source))
      .toMatchObject({kind: "continue_with_feedback", responseRejection: exchange.responseRejection, modelItems: []});
    Object.assign(f.stage, {status: "accepted", receipt: {id: "response-acceptance", requestId: "task:model", resultId: "raw", owner: "task-decision", progress}});
    const handoff = createTaskModelResponseHandoff("task", f.original);
    expect(await readTaskModelResponseHandoff(f.activities, handoff)).toMatchObject({kind: "accepted", progress});
    if (kind.startsWith("output_limit")) {
      const saved = f.stage.receipt;
      Object.assign(f.stage, {receipt: {...saved, progress: {...progress, exchange: {...exchange, responseRejection: null}}}});
      await expect(readTaskModelResponseHandoff(f.activities, handoff)).rejects.toThrow("task_response_rejection_missing");
      Object.assign(f.stage, {receipt: saved});
    }
    Object.assign(f.path, {cancelled: true, controlRevision: 1});
    const settled = await f.handler.settle(f.path, f.stage, new AbortController().signal, {id: "settled-response"});
    Object.assign(f.stage, {status: "settled", receipt: null, settlement: {id: "settled-response", requestId: "task:model", resultId: "raw", owner: "task-decision", disposition: settled.disposition}});
    expect(await readTaskModelResponseHandoff(f.activities, handoff)).toMatchObject({kind: "settled_response", progress: {exchange: {modelItems: [],
      responseRejection: {responseAcceptanceId: "settled-response"}, resultPresentationReceipt: {responseAcceptanceId: "settled-response"}}}});
    Object.assign(f.stage.result!, {value: {kind: "succeeded", response: f.response}});
    await expect(readTaskModelResponseHandoff(f.activities, handoff)).rejects.toThrow("rejection_raw_changed");
  });
  it("still rejects corrupted input evidence when the response is malformed", async () => {
    const f = responsePathFixture(), prepared = {...f.prepared, encoded: {...f.prepared.encoded, body: "changed"}};
    Object.assign(f.stage.request, {input: prepared});
    f.selections.command.mockResolvedValue({...f.binding, input: {...f.binding.input, exactInput: prepared}});
    Object.assign(f.stage.result!, {value: {kind: "succeeded", response: {...f.response, turn: null}}});
    await expect(f.handler.interpret(f.path, f.stage, new AbortController().signal, {id: "response-acceptance"})).rejects.toThrow("encoded_model_input_binding_changed");
  });
  it.each(["missing", "raw", "declaration", "message"])("rejects %s during accepted-stage recovery", async changed => {
    const f = responsePathFixture();
    const result = await f.handler.interpret(f.path, f.stage, new AbortController().signal, {id: "response-acceptance"});
    const progress = structuredClone(result.progress) as TaskModelResponseProgress;
    Object.assign(f.stage, {status: "accepted", receipt: {id: "response-acceptance", requestId: "task:model", resultId: "raw", owner: "task-decision", progress}});
    if (changed === "missing") Object.assign(progress, {exchange: null, proposal: null, state: "response_not_usable"});
    if (changed === "raw") Object.assign(f.stage.result!, {value: {kind: "succeeded", response: {...f.response, metadata: {changed: true}}}});
    if (changed === "declaration") {
      const receipt = progress.exchange!.resultPresentationReceipt!;
      const presentations = receipt.presentations.map(p => ({...p, bindings: p.bindings.map(b => ({...b, source: {...b.source, id: "other-source"}}))}));
      Object.assign(progress.exchange!, {resultPresentationReceipt: rehash({...receipt, presentations})});
    }
    if (changed === "message") Object.assign(progress.exchange!, {modelItems: createControllerModelItems({...f.response.turn,
      assistant: {role: "assistant", content: [{kind: "text", text: "Different response"}]}})});
    await expect(readTaskModelResponseHandoff(f.activities, createTaskModelResponseHandoff("task", f.original))).rejects.toThrow();
  });
  it.each([false, true])("carries typed receipt after interpretation failure=%s and recovers without current selection", async failure => {
    const f = responsePathFixture();
    if (failure) f.interpret.mockRejectedValue(new Error("Malformed output"));
    const result = await f.handler.interpret(f.path, f.stage, new AbortController().signal, {id: "response-acceptance"});
    const progress = result.progress as TaskModelResponseProgress;
    expect(progress.state).toBe(failure ? "response_not_usable" : "interpreted");
    expect(progress.exchange?.resultPresentationReceipt).toEqual(f.receipt);
    if (!failure) expect(progress.proposal?.resultPresentationReceipt).toEqual(f.receipt);
    expect(result.participants).toMatchObject([{owner: "context_delivery", kind: "accept", proposal: {inputId: "task:model:input", responseId: "raw"}}]);
    Object.assign(f.stage, {status: "accepted", receipt: {id: "response-acceptance", requestId: "task:model", resultId: "raw", owner: "task-decision", progress}});
    const handoff = createTaskModelResponseHandoff("task", f.original);
    f.selections.command.mockRejectedValue(new Error("Current selection must not be read"));
    expect(await readTaskModelResponseHandoff(f.activities, handoff)).toMatchObject({kind: "accepted", progress});
    expect(f.selections.command).toHaveBeenCalledTimes(1);
    Object.assign(f.stage.receipt!, {id: "changed-acceptance"});
    await expect(readTaskModelResponseHandoff(f.activities, handoff)).rejects.toThrow("accepted_input_changed");
  });
  it("retains actual presentation on cancelled settlement without advancing or consuming it early", async () => {
    const f = responsePathFixture();
    Object.assign(f.path, {cancelled: true, controlRevision: 1});
    const result = await f.handler.settle(f.path, f.stage, new AbortController().signal, {id: "response-acceptance"});
    expect(result.disposition).toMatchObject({kind: "retained_task_result", decisionAccepted: false,
      response: {exchange: {resultPresentationReceipt: f.receipt}}});
    expect(f.activities.command).not.toHaveBeenCalledWith(expect.objectContaining({kind: "dispatch"}));
    expect(f.projection.messages[1]).toEqual(f.message);
    Object.assign(f.stage, {status: "settled", settlement: {id: "response-acceptance", requestId: "task:model", resultId: "raw", owner: "task-decision", disposition: result.disposition}});
    expect(await readTaskModelResponseHandoff(f.activities, createTaskModelResponseHandoff("task", f.original))).toMatchObject({kind: "settled_response"});
  });
});
