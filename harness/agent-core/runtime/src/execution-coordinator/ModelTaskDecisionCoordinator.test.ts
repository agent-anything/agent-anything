import { afterEach, describe, expect, it, vi } from "vitest";
import {InMemoryContextPreparationStore} from "@agent-anything/context/preparation";
import {createModelNativeInputFootprint} from "@agent-anything/model-interaction/context";
import {createExactModelWorkingView, modelInputOccurrenceDigest, type ModelInputOwnerForm} from "@agent-anything/model-interaction/input";
import {prepareContextRepresentation, freezePreparedProviderRequest, type ContextRepresentationPreparationSupport} from "../context-representation/ContextRepresentationPreparation.js";
import {DirectTaskDecisionCoordinator} from "./DirectTaskDecisionCoordinator.js";
import {prepareContextSemanticAccount, contextSemanticTargetDigest} from "../context-representation/ContextSemanticPreparation.js";
import {prepareContextBackground} from "../context-representation/ContextBackgroundPreparation.js";
import type {RunPreparationRecord, RunPreparationWorkPort} from "../context-representation/RunPreparationWork.js";
import {ActivityCheckpointError, type ActivityCheckpointPort} from "../activity/ActivityCheckpoint.js";
import {RetryCheckpointError} from "../retry/RetryCheckpoint.js";
import {RetryInvocationInvalidatedError} from "../retry/RetryWaitControl.js";
import {CONTEXT_ASSESSMENT_CRITERIA} from "@agent-anything/model-interaction/context";
import type {
  Provider,
  ProviderCallResult,
  ProviderRequest,
  ProviderResponse,
  ModelCallableRequest,
} from "@agent-anything/model-interaction";
import { providerGeneratedOutput, ProviderDeliverySession, createNativeToolTurnInteraction } from "@agent-anything/model-interaction";
import type { ModelResponseObservation } from "../model-access/ModelResponseObservation.js";
import { createFakeProviderContext, FakeProvider } from "@agent-anything/test-support";
import {
  composeModelInput,
  modelInputFromComposition,
  modelInputFromSections,
} from "@agent-anything/model-interaction/input";
import {
  createInMemoryModelContinuationStore,
  ModelContinuationLifecycle,
} from "@agent-anything/model-interaction/continuation";
import { createAgentInstructions, type AgentDefinition } from "@agent-anything/agent-core/agent";
import { snapshotContextProjection } from "@agent-anything/context/projection";
import {
  createRunCancellationController,
} from "../run/index.js";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type { AgentActivityExecutionContext, TaskDecisionProposal, TaskDecisionInputSources } from "../decision/TaskDecisionActivity.js";
import { createToolCatalogSnapshot } from "@agent-anything/tools/catalog";
import {
  TaskDecisionActivityError,
  ModelTaskDecisionCoordinator,
  validateTaskDecisionProposal,
} from "./ModelTaskDecisionCoordinator.js";
import { createControllerModelItems } from "../decision/TaskDecisionModelItems.js";
import { createInputDeliverySections } from "../decision/DecisionInputDelivery.js";
import { RunInputNotifications } from "./RunInputNotifications.js";
import { createModelOutputRecoverySection } from "../decision/ModelOutputRecovery.js";
import {
  StructuredOutputError,
  type ProviderRequestBuildContext,
} from "../decision/StructuredOutput.js";
import {
  createSystemRetryExecutor,
  systemRetryClock,
} from "../retry/index.js";
import { createAgentInstructionBinding } from "../instructions/index.js";

interface TestOutput {
  readonly summary: string;
}

type TestProviderRequest = Omit<
  ProviderRequest,
  "requestId" | "instructions" | "composition"
>;

const TEST_OUTPUT_FORMAT = Object.freeze({
  kind: "json_schema" as const,
  name: "test_controller_decision",
  schemaId: "test.controller-decision",
  schemaRevision: "1",
  schema: Object.freeze({ type: "object" }),
});

describe("ModelTaskDecisionCoordinator", () => {
  afterEach(() => vi.useRealTimers());
  it("coordinates a direct decision without Provider access or invented model records", async () => {
    const decide = vi.fn(async (bound: import("../decision/TaskDecisionMaker.js").BoundTaskDecisionInput<TestOutput>) => {
      expect(bound.kind).toBe("direct");
      return {kind: "propose_completion" as const, completionSource: {kind: "controller" as const}, candidates: [], output: {summary: "Direct result"}, modelItems: []};
    });
    const coordinator = new DirectTaskDecisionCoordinator({decide});
    const source = createControllerInput(), context = {...callContext(), checkpoints: memoryCheckpoints()};
    const first = await coordinator.next(source, context);
    expect(first.modelItems).toEqual([]);
    expect(await coordinator.recover(source, context)).toEqual(first);
    expect(decide).toHaveBeenCalledTimes(1);
    await expect(coordinator.recover({...source, runId: "different-run"}, context)).rejects.toBeInstanceOf(ActivityCheckpointError);
  });
  it("binds a previously accepted immutable input after another view is selected, but rejects changed content and cancellation", async () => {
    const provider = new FakeProvider({results: [succeededResult({summary: "Done"})]});
    const context = {...callContext(), runCheckpoints: memoryCheckpoints(), checkpoints: memoryCheckpoints()};
    await createController(provider, {contextPreparation: {store: new InMemoryContextPreparationStore()}})
      .next(createControllerInput(), context);
    const request = provider.requests()[0]!;
    await context.runCheckpoints.commit("context-preparation:selected.v1", {id: "later-selection", epoch: 2, viewId: "later-view"});
    await context.runCheckpoints.commit("context-preparation:registration.v1", {id: "later-selection", epoch: 2});
    await freezePreparedProviderRequest(request, context, "original-binding-replayed");
    await expect(freezePreparedProviderRequest({...request, metadata: {...request.metadata, changed: true}}, context, "tampered"))
      .rejects.toBeInstanceOf(ActivityCheckpointError);
    const cancellation = createRunCancellationController({runId: "run_001"});
    cancellation.requestCancellation({origin: "host", reasonCode: "host_requested"});
    await expect(freezePreparedProviderRequest(request, {...context, cancellation: cancellation.context}, "cancelled"))
      .rejects.toBeDefined();
  });
  it.each([{eligible: true, unknown: false}, {eligible: false, unknown: false}, {eligible: true, unknown: true}, {eligible: false, unknown: true}])(
    "prepares changed input once after actual window rejection (%j)", async ({eligible, unknown}) => {
    const fixture = semanticProvider("adequate"), seen: ProviderRequest[] = [];
    const provider: Provider = {...fixture.provider, modelContext: {...fixture.provider.modelContext,
      accounting: {...fixture.provider.modelContext.accounting!, defaultGenerationRoom: 0},
      ...(unknown ? {measure: (composition: ProviderRequest["composition"], measuredAt: string) => ({status: "unknown" as const,
        unit: "tokens" as const, accuracy: "unknown" as const, estimator: null, reason: "unsupported" as const,
        measuredAt, measuredCompositionId: composition.id})} : {})},
      send: async (value, context, delivery) => {
        seen.push(value);
        if (seen.length === 1) return {kind: "failed", failure: {category: "invalid_request", code: "provider_context_window_exceeded",
          message: "Actual endpoint rejected this input", statusCode: 400, metadata: {}}};
        return fixture.provider.send(value, context, delivery);
      }};
    const controller = createController(provider, {contextPreparation: {store: new InMemoryContextPreparationStore(), semantic: {revision: "1"}},
      buildRequest: () => request("Original report: " + "detail ".repeat(2000)),
      prepareRequest: value => {
        const sections = value.composition.sections.map(section => section.role === "user" && !section.provenance && eligible ? {...section,
          preservation: {obligations: [{id: "report", requirement: "account" as const, basis: "Source owner permits account"}], relationships: []}} : section);
        return {...value, composition: {...value.composition, sections, workingView: createExactModelWorkingView({sections, recipientRunId: "run_001", boundary: "request"})}};
      }, parseResponse: () => {
        const decision = finalDecision({summary: "Done"});
        return {...decision, modelItems: decision.modelItems.map(item => item.kind === "model_response_correlation" ?
          {...item, response: {...item.response, requestId: seen.at(-1)!.requestId}} : item)};
      }});
    const context = {...callContext(), runCheckpoints: memoryCheckpoints(), checkpoints: memoryCheckpoints()};
    const operation = controller.next(createControllerInput(), context);
    if (eligible) {
      await operation;
      expect(seen.map(value => value.purpose)).toEqual(["agent-control", "context_generation", "context_assessment", "agent-control"]);
      expect(seen.at(-1)!.composition.workingView.accounts).toHaveLength(1);
      expect(JSON.stringify(seen.at(-1)!.messages)).not.toContain("detail detail");
      if (unknown) expect(seen.at(-1)!.modelContext.assessment?.planning?.measurement.status).toBe("unknown");
      await controller.recover(createControllerInput(), context);
      expect(seen).toHaveLength(4);
    } else {
      await expect(operation).rejects.toMatchObject({failure: {failure: {code: "model_context_capacity_exceeded"}}});
      expect(seen).toHaveLength(1);
    }
  });
  it("refines rejected auxiliary input into bounded assessed leaves and reuses them on recovery", async () => {
    const fixture = semanticProvider("adequate"), seen: ProviderRequest[] = [];
    const provider: Provider = {...fixture.provider, modelContext: {...fixture.provider.modelContext,
      accounting: {...fixture.provider.modelContext.accounting!, defaultGenerationRoom: 0},
      measure: (composition, measuredAt) => ({status: "unknown", unit: "tokens", accuracy: "unknown", estimator: null,
        reason: "unsupported", measuredCompositionId: composition.id, measuredAt})}, send: async (value, context, delivery) => {
        seen.push(value);
        const data = value.purpose === "context_generation" ? JSON.parse((value.messages[0]!.content[0] as {text: string}).text) : null;
        if (seen.length === 1 || data?.replacementSources.length > 1 && data.replacementSources.some((s: {content: unknown}) => JSON.stringify(s.content).includes("detail detail"))) {
          return {kind: "failed", failure: {category: "invalid_request", code: "provider_context_window_exceeded", message: "Synthetic complete auxiliary window rejection", statusCode: 400, metadata: {}}};
        }
        return fixture.provider.send(value, context, delivery);
      }};
    const controller = createController(provider, {contextPreparation: {store: new InMemoryContextPreparationStore(),
      semantic: {revision: "1", work: {maximumSourceBytes: 64 * 1024, maximumNodes: 9}}},
      buildRequest: () => request("Original report"), prepareRequest: value => {
        const sections = value.composition.sections.flatMap(section => section.role === "user" && !section.provenance ? [1, 2, 3].map(index => ({...section,
          id: `${section.id}:${index}`, source: {...section.source, id: `${section.source.id}:${index}`}, content: {kind: "text" as const, text: "detail ".repeat(1100)},
          preservation: {obligations: [{id: "report", requirement: "account" as const, basis: "Source owner permits account"}], relationships: []}})) : [section]);
        const projected = modelInputFromSections(sections);
        return {...value, ...projected, composition: {...value.composition, ...projected, sections,
          workingView: createExactModelWorkingView({sections, recipientRunId: "run_001", boundary: "request"})}};
      }, parseResponse: () => {
        const decision = finalDecision({summary: "Done"});
        return {...decision, modelItems: decision.modelItems.map(item => item.kind === "model_response_correlation" ?
          {...item, response: {...item.response, requestId: seen.at(-1)!.requestId}} : item)};
      }});
    const context = {...callContext(), runCheckpoints: memoryCheckpoints(), checkpoints: memoryCheckpoints()};
    await controller.next(createControllerInput(), context);
    const calls = seen.length;
    const final = seen.at(-1)!;
    expect(final.composition.workingView.accounts).toHaveLength(1);
    expect(final.composition.workingView.accounts![0]!.derivation.evidence).toHaveLength(3);
    expect(new Set(seen.map(value => value.requestId)).size).toBe(calls);
    expect(seen.filter(value => value.purpose === "context_generation").length).toBeLessThanOrEqual(9);
    await controller.recover(createControllerInput(), context);
    expect(seen).toHaveLength(calls);
  });
  it.each(["adequate", "unknown", "invalid"] as const)("separates semantic generation, assessment and selection (%s), then replays without new work", async verdict => {
    const {provider, requests} = semanticProvider(verdict);
    const store = new InMemoryContextPreparationStore();
    const controller = createController(provider, {contextPreparation: {store, semantic: {revision: "1"}},
      buildRequest: () => request("Original report: " + "detail ".repeat(2000)), prepareRequest: value => {
        const sections = value.composition.sections.map(section => section.role === "user" && !section.provenance ? {...section,
          preservation: {obligations: [{id: "report", requirement: "account" as const, basis: "Source owner permits account"}], relationships: []}} : section);
        return {...value, composition: {...value.composition, sections,
          workingView: createExactModelWorkingView({sections, recipientRunId: "run_001", boundary: "request"})}};
      }, parseResponse: () => {
        const decision = finalDecision({summary: "Done"});
        return {...decision, modelItems: decision.modelItems.map(item => item.kind === "model_response_correlation" ?
          {...item, response: {...item.response, requestId: requests.at(-1)!.requestId}} : item)};
      }});
    const charged = new Map<string, unknown>();
    const context = {...callContext(), runCheckpoints: memoryCheckpoints(), checkpoints: memoryCheckpoints(), auxiliaryUsage: {
      assertAvailable: () => {}, record: async (value: import("../model-access/AuxiliaryModelUsage.js").AuxiliaryModelUsage) => {
        if (charged.has(value.attemptId)) expect(charged.get(value.attemptId)).toEqual(value);
        charged.set(value.attemptId, value);
      },
    }};
    const decision = await controller.next(createControllerInput(), context);
    expect(requests.map(value => value.purpose), JSON.stringify(requests.at(-1)?.modelContext.assessment?.planning)).toEqual(verdict === "invalid" ?
      ["context_generation", "agent-control"] : ["context_generation", "context_assessment", "agent-control"]);
    expect(requests[0]!.composition.lineage.agent).toBeNull();
    expect(requests[1]!.interaction.kind).toBe("structured_generation");
    const actual = requests.at(-1)!;
    expect(actual.composition.workingView.accounts?.length ?? 0).toBe(verdict === "adequate" ? 1 : 0);
    expect(JSON.stringify(actual.messages).includes("detail detail")).toBe(verdict !== "adequate");
    if (verdict === "adequate") expect(decision.modelItems.find(value => value.kind === "model_response_correlation")?.metadata.workingAccounts).toHaveLength(1);
    await controller.recover(createControllerInput(), context);
    expect(requests).toHaveLength(verdict === "invalid" ? 2 : 3);
    expect(charged.size).toBe(verdict === "invalid" ? 1 : 2);
    if (verdict === "unknown") {
      const resend = vi.fn(async () => {throw new Error("A new request ID must not reset semantic work");});
      const next = await prepareContextSemanticAccount({store, request: {...actual, requestId: "later-request"}, runId: "run_001",
        preparationId: "later-preparation", deadlineAt: context.retry.deadlineAt, support: {revision: "1"},
        targetDigest: contextSemanticTargetDigest(provider), send: resend, measure: async value => value, guard: async () => {}});
      expect(next.accounts).toEqual([]);
      expect(next.limitations).toContain("semantic_basis_already_attempted");
      expect(resend).not.toHaveBeenCalled();
    }
  });
  it.each([true, false])("does not restart a spent background/foreground basis after another Turn (foreground: %s)", async foreground => {
    const fixture = semanticProvider("unknown"), store = new InMemoryContextPreparationStore();
    const support = {revision:"1",background:{enabled:true as const,revision:"1"}};
    const controller=createController(fixture.provider,{contextPreparation:foreground ? {store,semantic:support}:undefined,
      buildRequest:()=>request("Original report: "+"detail ".repeat(2000)),prepareRequest:value=>{
        const sections=value.composition.sections.map(section=>section.role==="user"&&!section.provenance?{...section,
          preservation:{obligations:[{id:"report",requirement:"account" as const,basis:"Source owner permits account"}],relationships:[]}}:section);
        return {...value,composition:{...value.composition,sections,workingView:createExactModelWorkingView({sections,recipientRunId:"run_001",boundary:"request"})}};
      },parseResponse:()=>{
        const decision=finalDecision({summary:"Done"});
        return {...decision,modelItems:decision.modelItems.map(item=>item.kind==="model_response_correlation"?
          {...item,response:{...item.response,requestId:fixture.requests.at(-1)!.requestId}}:item)};
      }});
    const context={...callContext(),runCheckpoints:memoryCheckpoints(),checkpoints:memoryCheckpoints()};
    await controller.next(createControllerInput(),context);
    const original=fixture.requests.at(-1)!, planning=original.modelContext.assessment!.planning!;
    if(planning.measurement.status!=="measured")throw new Error("Expected measured input");
    const early={...original,modelContext:{...original.modelContext,assessment:{...original.modelContext.assessment!,planning:{...planning,
      workingTarget:planning.measurement.amount+1,growthAllowance:2}}}};
    const records=new Map<string,RunPreparationRecord>();
    const start=vi.fn<RunPreparationWorkPort["start"]>(async registration=>{
      records.set(registration.id,{...registration,authority:"test",status:"failed",failure:"known failure"});return true;
    });
    const port:RunPreparationWorkPort={current:()=>null,read:id=>records.get(id)??null,start,wait:async()=>{}};
    const input={store,request:early,runId:"run_001",support,targetDigest:contextSemanticTargetDigest(fixture.provider),
      context:{...context,auxiliaryWork:port},measure:async(value:ProviderRequest)=>value,send:vi.fn(async()=>{throw new Error("No new dispatch expected");})};
    await prepareContextBackground(input);
    expect(start).toHaveBeenCalledTimes(foreground?0:1);
    const retry=await prepareContextBackground({...input,capacityRejected:true});
    if(!foreground)expect(retry).toMatchObject({status:"unavailable"});
    await prepareContextBackground(input);
    expect(start).toHaveBeenCalledTimes(foreground?0:1);
    expect(input.send).not.toHaveBeenCalled();
  });
  it("keeps an admitted exact view when an optional source-form proposal fails", async () => {
    const provider = new FakeProvider({results: [succeededResult({summary: "Done"})]});
    const store = new InMemoryContextPreparationStore();
    const opened = vi.spyOn(store, "open");
    const resolve = vi.fn(async () => {throw new Error("Owner proposal unavailable");});
    const controller = createController(provider, {contextPreparation: {store, forms: {revision: "1", resolve}}});
    const context = {...callContext(), runCheckpoints: memoryCheckpoints(), checkpoints: memoryCheckpoints()};
    await controller.next(createControllerInput(), context);
    await controller.recover(createControllerInput(), context);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(provider.requests()).toHaveLength(1);
    expect(provider.requests()[0]!.composition.workingView.forms).toBeUndefined();
    expect(await store.read(opened.mock.calls[0]![0].id, "candidate")).toMatchObject({status: "ready", value: {
      limitations: expect.arrayContaining(["optional_form_proposal_failed:Error"]), forms: []}});
  });
  it("does not publish or dispatch cancelled preparation, and a fresh Run remains usable", async () => {
    const provider = new FakeProvider({results: [succeededResult({summary: "Done"})]});
    const store = new InMemoryContextPreparationStore();
    const opened = vi.spyOn(store, "open");
    const cancellation = createRunCancellationController({runId: "run_001"});
    let entered = false;
    const controller = createController(provider, {contextPreparation: {store, forms: {revision: "1", resolve: async () => {
      entered = true; await new Promise(() => {}); return {offered: [], expand: []};
    }}}});
    const run = memoryCheckpoints();
    const pending = captureError(controller.next(createControllerInput(), {...callContext(cancellation.context), runCheckpoints: run, checkpoints: memoryCheckpoints()}));
    await vi.waitFor(() => expect(entered).toBe(true));
    cancellation.requestCancellation({origin: "host", reasonCode: "host_requested"});
    await pending;
    expect(provider.requests()).toHaveLength(0);
    expect(run.read("context-preparation:selected.v1")).toBeNull();
    expect((await store.open(opened.mock.calls[0]![0])).state).toBe("retired");
    await createController(provider, {contextPreparation: {store: new InMemoryContextPreparationStore()}}).next(createControllerInput(),
      {...callContext(), runCheckpoints: memoryCheckpoints(), checkpoints: memoryCheckpoints()});
    expect(provider.requests()).toHaveLength(1);
  });
  it("freezes independent preparation stages and recovers the same request without another Provider call", async () => {
    const provider = new FakeProvider({results: [succeededResult({summary: "Done"})]});
    const store = new InMemoryContextPreparationStore();
    const write = vi.spyOn(store, "write");
    const run = memoryCheckpoints(), invocation = memoryCheckpoints();
    const controller = createController(provider, {contextPreparation: {store}});
    const context = {...callContext(), runCheckpoints: run, checkpoints: invocation};
    const first = await controller.next(createControllerInput(), context);
    const stages = write.mock.calls.length;
    expect(stages).toBe(5);
    expect(await controller.recover(createControllerInput(), context)).toEqual(first);
    expect(write.mock.calls).toHaveLength(stages);
    expect(provider.requests()).toHaveLength(1);
    expect(run.read("context-preparation:selected.v1")).toMatchObject({epoch: 1});
  });
  it("adopts an owner-approved account, not arbitrary text truncation, before actual dispatch", async () => {
    const fake = new FakeProvider({results: [succeededResult({summary: "Done"})]});
    const original = ensureTestProviderContext(fake);
    const capacity = {supported: true as const, unit: "tokens" as const, maximum: 2000, semantics: "input_only" as const,
      source: "host_configured" as const, providerId: original.descriptor.id, model: original.modelContext.target.model, revision: "test"};
    const provider: Provider = {...original, modelContext: {...original.modelContext, capacity,
      accounting: {basis: {fixture: "owner-forms"}, inputUsage: "complete", outputUsage: "complete", defaultGenerationRoom: null, limitations: [],
        project: composition => createModelNativeInputFootprint({messages: composition.messages})},
      measure: (composition, measuredAt) => ({status: "measured", amount: JSON.stringify(composition.messages).length,
        estimator: {id: "test", revision: "1", unit: "tokens", accuracy: "exact"}, uncertainty: {kind: "none"}, measuredAt, measuredCompositionId: composition.id})},
      descriptor: {...original.descriptor, capabilities: {...original.descriptor.capabilities,
        modelContext: {...original.descriptor.capabilities.modelContext, capacity}}}, send: fake.send.bind(fake)};
    let offered: ModelInputOwnerForm | undefined;
    const controller = createController(provider, {contextPreparation: {store: new InMemoryContextPreparationStore(), forms: {revision: "1", resolve: async ({request}) => {
      const section = request.composition.sections.find(value => value.role === "user")!;
      offered = {id: "owner-account", sectionId: section.id, sourceDigest: modelInputOccurrenceDigest(section), owner: {...section.source, kind: "presenter"},
        method: "owner_presentation", content: {kind: "model_message", message: {role: "user", content: [{kind: "text", text: "Owner account: the retained report is complete."}]}},
        satisfies: ["report"], companions: [], dependencies: [], limitations: ["Owner-authored reduced account"]};
      return {offered: [offered], expand: []};
    }}}, parseResponse: () => {
      const decision = finalDecision({summary: "Done"});
      return {...decision, modelItems: decision.modelItems.map(item => item.kind === "model_response_correlation" ?
        {...item, response: {...item.response, requestId: fake.requests().at(-1)!.requestId}} : item)};
    }, buildRequest: () => request("REPORT " + "detail ".repeat(2000)), prepareRequest: value => {
      const sections = value.composition.sections.map(section => section.role === "user" && !section.provenance ? {...section,
        preservation: {obligations: [{id: "report", requirement: "account" as const, basis: "Explicit source owner account"}], relationships: []}} : section);
      return {...value, composition: {...value.composition, sections,
        workingView: createExactModelWorkingView({sections, recipientRunId: "run_001", boundary: "request"})}};
    }});
    const base = createControllerInput();
    const queue = new RunInputNotifications();
    queue.collect(base.runId, {read: () => [{runId: base.runId, sequence: 1, occurredAt: "2026-10-13T00:00:00.000Z",
      source: {owner: "process", kind: "scope_closed", id: "process-1", revision: "4"}, data: {exitCode: 0}}]}, 8192);
    const inputDelivery = queue.prepare(base.runId, base.toolExposure.controllerRequestId)!;
    const decision = await controller.next({...base, inputDelivery}, {...callContext(), runCheckpoints: memoryCheckpoints(), checkpoints: memoryCheckpoints()});
    const actual = fake.requests()[0]!;
    expect(actual.composition.workingView.forms, JSON.stringify(actual.modelContext.assessment?.planning)).toEqual([offered]);
    expect(JSON.stringify(actual.messages)).toContain("Owner account");
    expect(JSON.stringify(actual.messages)).not.toContain("detail detail");
    expect(decision.modelItems.find(value => value.kind === "model_response_correlation")?.metadata.workingForms).toEqual([offered]);
    expect(JSON.stringify(actual.messages)).toContain("host_notification");
    expect(decision.inputDeliveryReceipt).toMatchObject({batch: {id: inputDelivery.id},
      via: {kind: "provider", requestId: actual.requestId, workingViewId: actual.composition.workingView.id}});
    expect(queue.undelivered).toBe(1);
  });
  it("recovers a recorded capacity failure without remeasuring, consuming pending input or calling the Provider", async () => {
    const fake = new FakeProvider({results: []});
    const original = ensureTestProviderContext(fake);
    const capacity = {supported: true as const, unit: "tokens" as const, maximum: 1, semantics: "input_only" as const,
      source: "host_configured" as const, providerId: original.descriptor.id, model: original.modelContext.target.model, revision: "test"};
    const measure = vi.fn((composition: ProviderRequest["composition"], measuredAt: string) => ({status: "measured" as const, amount: 200,
      estimator: {id: "test", revision: "1", unit: "tokens" as const, accuracy: "exact" as const}, uncertainty: {kind: "none" as const},
      measuredAt, measuredCompositionId: composition.id}));
    const provider: Provider = {...original, modelContext: {...original.modelContext, capacity, measure},
      descriptor: {...original.descriptor, capabilities: {...original.descriptor.capabilities,
        modelContext: {...original.descriptor.capabilities.modelContext, capacity}}}, send: fake.send.bind(fake)};
    const store = new InMemoryContextPreparationStore();
    const opened = vi.spyOn(store, "open"), written = vi.spyOn(store, "write");
    const controller = createController(provider, {contextPreparation: {store}});
    const queue = new RunInputNotifications();
    const base = createControllerInput();
    queue.collect(base.runId, {read: () => [{runId: base.runId, sequence: 1, occurredAt: "2026-10-13T00:00:00.000Z",
      source: {owner: "process", kind: "scope_closed", id: "process-1", revision: "4"}, data: {exitCode: 0}}]}, 8192);
    const input = {...base, inputDelivery: queue.prepare(base.runId, base.toolExposure.controllerRequestId)!};
    const context = {...callContext(), runCheckpoints: memoryCheckpoints(), checkpoints: memoryCheckpoints()};
    const first = await captureError(controller.next(input, context));
    expect(first).toBeInstanceOf(TaskDecisionActivityError);
    expect(first).toMatchObject({failure: {kind: "model", failure: {code: "model_context_capacity_exceeded"}}, operationSettlement: "settled_failure"});
    const measured = measure.mock.calls.length, writes = written.mock.calls.length;
    const recovered = await captureError(controller.recover(input, context));
    expect(recovered).toBeInstanceOf(TaskDecisionActivityError);
    expect((recovered as TaskDecisionActivityError).failure).toEqual((first as TaskDecisionActivityError).failure);
    expect(measure).toHaveBeenCalledTimes(measured);
    expect(written).toHaveBeenCalledTimes(writes);
    expect(fake.requests()).toHaveLength(0);
    expect(queue.undelivered).toBe(1);
    expect(context.runCheckpoints.read("context-preparation:selected.v1")).toBeNull();
    expect(await store.read(opened.mock.calls[0]![0].id, "admitted")).toMatchObject({status: "failed", failure: {kind: "controller"}});
  });
  it("rejects admission that silently replaces the prepared request", async () => {
    const provider = new FakeProvider({results: [succeededResult({summary: "Done"})]});
    const input = createControllerInput();
    await createController(provider).next(input, callContext());
    const context = {...callContext(), runCheckpoints: memoryCheckpoints(), checkpoints: memoryCheckpoints()};
    await expect(prepareContextRepresentation({support: {store: new InMemoryContextPreparationStore()},
      request: provider.requests()[0]!, controller: input, context, now: Date.now,
      measure: async value => value, admit: async value => ({...value, requestId: "unprepared-replacement",
        composition: {...value.composition, id: "unprepared-replacement"}, modelContext: {...value.modelContext, assessment: null}})}))
      .rejects.toThrow("Context admission cannot replace the prepared input");
    expect(context.runCheckpoints.read("context-preparation:selected.v1")).toBeNull();
  });
  it("aborts the actual preparation work at its deadline and rejects a late candidate", async () => {
    const provider = new FakeProvider({results: [succeededResult({summary: "Done"})]});
    const controller = createControllerInput();
    await createController(provider).next(controller, callContext());
    vi.useFakeTimers();
    const context = {...callContext(), runCheckpoints: memoryCheckpoints(), checkpoints: memoryCheckpoints()};
    context.retry = {...context.retry, deadlineAt: new Date(Date.now() + 100).toISOString()};
    let workSignal: AbortSignal | undefined, finish: ((value: ProviderRequest) => void) | undefined;
    const support = {store: new InMemoryContextPreparationStore()};
    const pending = captureError(prepareContextRepresentation({support, request: provider.requests()[0]!, controller, context, now: Date.now,
      measure: (_request, signal) => {workSignal = signal; return new Promise(resolve => {finish = resolve;});},
      admit: async value => value}));
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending as Error).message).toBe("context_preparation_deadline_exceeded");
    expect(workSignal?.aborted).toBe(true);
    finish!(provider.requests()[0]!);
    await vi.advanceTimersByTimeAsync(0);
    expect(context.runCheckpoints.read("context-preparation:selected.v1")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([new ActivityCheckpointError("candidate-basis"), new RetryCheckpointError("capacity-recovery"), new RetryInvocationInvalidatedError()])(
    "preserves coordination failure classification on replay ($name)", async failure => {
      const provider = new FakeProvider({results: [succeededResult({summary: "Done"})]});
      const controller = createControllerInput();
      await createController(provider).next(controller, callContext());
      const measure = vi.fn(async () => {throw failure;});
      const input = {support: {store: new InMemoryContextPreparationStore()}, request: provider.requests()[0]!, controller,
        context: {...callContext(), runCheckpoints: memoryCheckpoints(), checkpoints: memoryCheckpoints()}, now: Date.now,
        measure, admit: async (value: ProviderRequest) => value};
      expect(await captureError(prepareContextRepresentation(input))).toBe(failure);
      const replayed = await captureError(prepareContextRepresentation(input));
      expect(replayed).toBeInstanceOf(failure.constructor);
      expect(replayed).toMatchObject(failure);
      expect(measure).toHaveBeenCalledTimes(1);
      expect(input.context.runCheckpoints.read("context-preparation:selected.v1")).toBeNull();
    });
  it("cancels asynchronous measurement before dispatch and leaves subsequent work usable", async () => {
    const fake = new FakeProvider({results: [succeededResult({summary: "Done"})]});
    const original = ensureTestProviderContext(fake);
    let entered = false;
    let first = true;
    const provider = {descriptor: original.descriptor, requestBodyTransportLimit: original.requestBodyTransportLimit,
      modelContext: {...original.modelContext, measureAsync: (composition, at, signal) => {
        if (!first) return Promise.resolve(original.modelContext.measure(composition, at));
        first = false; entered = true;
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}));
      }}, send: fake.send.bind(fake)} as Provider;
    const cancellation = createRunCancellationController({runId: "run_001"});
    const promise = captureError(createController(provider).next(createControllerInput(), callContext(cancellation.context)));
    await vi.waitFor(() => expect(entered).toBe(true));
    cancellation.requestCancellation({origin: "host", reasonCode: "host_requested"});
    await promise;
    expect(fake.requests()).toHaveLength(0);
    await createController(provider).next(createControllerInput(), callContext());
    expect(fake.requests()).toHaveLength(1);
  });

  it("acknowledges notification membership in the actual Provider composition without consuming the Runtime queue", async () => {
    const input = createControllerInput();
    const queue = new RunInputNotifications();
    queue.collect(input.runId, {read: () => [{runId: input.runId, sequence: 1, occurredAt: "2026-10-13T00:00:00.000Z",
      source: {owner: "process", kind: "scope_closed", id: "process-1", revision: "4"}, data: {exitCode: 0}}]}, 8192);
    const inputDelivery = queue.prepare(input.runId, input.toolExposure.controllerRequestId)!;
    const provider = new FakeProvider({results: [succeededResult({summary: "Done"})]});
    const result = await createController(provider).next({...input, inputDelivery}, callContext());
    const actual = provider.requests()[0]!;
    expect(result.inputDeliveryReceipt).toMatchObject({batch: {id: inputDelivery.id},
      via: {kind: "provider", requestId: actual.requestId, compositionId: actual.composition.id}});
    expect(JSON.stringify(actual.messages)).toContain("host_notification");
    expect(queue.undelivered).toBe(1);
  });

  it("builds a request and returns Agent-validated final output with model provenance", async () => {
    const provider = new FakeProvider({
      results: [succeededResult({ summary: "Done" })],
    });
    const controller = createController(provider, {
      buildRequest(input) {
        return request(`Run ${input.runId} for task ${input.task.id}.`);
      },
      parseResponse(response) {
        return finalDecision(providerGeneratedOutput(response));
      },
    });

    const result = await controller.next(createControllerInput(), callContext());

    expect(result).toEqual({ candidates: [], completionSource: {kind: "controller" as const},
      kind: "propose_completion",
      output: { summary: "Done" },
      modelItems: modelItems("model_item_1", { summary: "Done" }),
    });
    expect(provider.requests()).toHaveLength(1);
    expect(provider.requests()[0]).toMatchObject({
      purpose: "agent-control",
      interaction: { kind: "structured_generation" },
      instructions: {
        content: [{ kind: "text", text: "Complete the test task." }],
      },
      messages: [
        { role: "user", content: [{ kind: "text", text: "Run run_001 for task task_001." }] },
      ],
      composition: { providerId: "fake-provider", model: "fake-model" },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.modelItems)).toBe(true);
  });

  it("reuses correlated Provider continuation while retaining complete current input", async () => {
    const requests: ProviderRequest[] = [];
    const store = createInMemoryModelContinuationStore();
    const provider: Provider = {
      descriptor: continuationProviderDescriptor(),
      async send(candidate) {
        requests.push(candidate);
        const ordinal = requests.length;
        return continuationSucceededResult(
          { summary: `Done ${ordinal}` },
          `response-${ordinal}`,
          `state-${ordinal}`,
        );
      },
    };
    const controller = createController(provider, {
      continuation: new ModelContinuationLifecycle({ store }),
      parseResponse: (response) => finalDecision(providerGeneratedOutput(response)),
    });

    await controller.next(createControllerInput(), callContext());
    await controller.next(createControllerInput(), callContext());

    expect(requests).toHaveLength(2);
    expect(requests[0].continuation).toBeNull();
    expect(requests[1].continuation).toMatchObject({
      responseId: "response-1",
      state: { handle: "state-1" },
    });
    expect(requests[1].messages).toEqual(requests[0].messages);
    expect(requests[1].composition.sections).toEqual(
      requests[0].composition.sections,
    );
  });

  it("performs exactly one non-Retry reset after correlated Provider rejection", async () => {
    const requests: ProviderRequest[] = [];
    const store = createInMemoryModelContinuationStore();
    const provider: Provider = {
      descriptor: continuationProviderDescriptor(),
      async send(candidate) {
        requests.push(candidate);
        if (requests.length === 1) {
          return continuationSucceededResult(
            { summary: "Seeded" },
            "response-1",
            "state-1",
          );
        }
        if (requests.length === 2) {
          if (candidate.continuation === null) {
            throw new Error("Expected continuation reuse.");
          }
          return {
            kind: "continuation_rejected",
            continuationId: candidate.continuation.id,
            providerCode: "invalid_previous_response",
          };
        }
        return continuationSucceededResult(
          { summary: "Reconstructed" },
          "response-2",
          "state-2",
        );
      },
    };
    const controller = createController(provider, {
      continuation: new ModelContinuationLifecycle({ store }),
      parseResponse: (response) => finalDecision(providerGeneratedOutput(response)),
    });

    await controller.next(createControllerInput(), callContext());
    await expect(controller.next(createControllerInput(), callContext()))
      .resolves.toMatchObject({
        kind: "propose_completion",
        output: { summary: "Reconstructed" },
      });

    expect(requests).toHaveLength(3);
    expect(requests[1].continuation).not.toBeNull();
    expect(requests[2].continuation).toBeNull();
    expect(requests[2].messages).toEqual(requests[1].messages);
    expect(requests[2].composition).toEqual(requests[1].composition);
  });

  it("preserves ordered candidates and validates their model-item references", async () => {
    const provider = new FakeProvider({
      results: [succeededResult({ action: "tools" })],
    });
    const controller = createController(provider, {
      parseResponse(_response, input) {
        const firstCall = modelCall("model_item_1", "workspace.readFile", 0);
        const secondCall = modelCall("model_item_2", "plan.update", 1);
        return {
          kind: "advance",
          candidates: [
            {
              kind: "tool_request",
              tool: {
                name: "workspace.readFile",
                revision: null,
                input: { path: "README.md" },
                origin: "model",
                controllerRequestId: input.toolExposure.controllerRequestId,
              },
              modelCallRef: firstCall.modelCallRef,
            },
            {
              kind: "state_transition",
              transition: "plan_update",
              input: { step: "Inspect README" },
              modelCallRef: secondCall.modelCallRef,
            },
          ],
          modelItems: modelCallItems([firstCall, secondCall]),
        };
      },
    });

    const result = await controller.next(createControllerInput(), callContext());

    expect(result.kind).toBe("advance");
    if (result.kind !== "advance") {
      throw new Error("Expected advance decision.");
    }
    expect(result.candidates.map((candidate) => candidate.kind)).toEqual([
      "tool_request",
      "state_transition",
    ]);
    expect(result.candidates.map((candidate) => candidate.modelCallRef.id)).toEqual([
      "model_item_1",
      "model_item_2",
    ]);
  });

  it("validates Plan-only requests without a separate decision branch", () => {
    const input = createControllerInput();
    const call = modelCall("plan_item_1", "update_plan", 0);
    const candidate = {
      kind: "state_transition" as const,
      transition: "plan_update" as const,
      input: { plan: [{ step: "Inspect files", status: "in_progress" }] },
      modelCallRef: call.modelCallRef,
    };
    const modelItems = modelCallItems([call]);
    const result = validateTaskDecisionProposal({ kind: "advance", candidates: [candidate], modelItems }, input);
    expect(result).toMatchObject({ kind: "advance", candidates: [candidate] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => validateTaskDecisionProposal({ kind: "advance", candidates: [], modelItems } as unknown as TaskDecisionProposal, input)).toThrow();
  });

  it("rejects completion that hides an unaccounted Tool call", () => {
    const input = createControllerInput();
    const call = modelCall("tool_item_1", "workspace.readFile", 0);
    expect(() => validateTaskDecisionProposal({
      kind: "propose_completion", candidates: [], completionSource: {kind: "controller"}, output: {summary: "Done"},
      modelItems: modelCallItems([call]),
    } as unknown as TaskDecisionProposal, input)).toThrow();
  });

  it("requires exact, unique coverage across completion source and ordered co-calls", () => {
    const input = createControllerInput();
    const plan = modelCall("plan", "update_plan", 0);
    const final = modelCall("final", "final_result", 1);
    const decision: TaskDecisionProposal = {
      kind: "propose_completion", output: { summary: "Done" },
      completionSource: { kind: "model_call", modelCallRef: final.modelCallRef },
      candidates: [{ kind: "state_transition", transition: "plan_update", input: {}, modelCallRef: plan.modelCallRef }],
      modelItems: modelCallItems([plan, final]),
    };
    expect(validateTaskDecisionProposal(decision, input)).toMatchObject({kind:"propose_completion",candidates:decision.candidates});
    for (const invalid of [
      { ...decision, candidates: [] },
      { ...decision, completionSource: { kind: "controller" } },
      { ...decision, completionSource: { kind: "model_call", modelCallRef: plan.modelCallRef } },
      { ...decision, completionSource: { kind: "model_call", modelCallRef: {...final.modelCallRef, turnId: "foreign"} } },
      { ...decision, candidates: [decision.candidates[0], decision.candidates[0]] },
      { ...decision, modelItems: [...decision.modelItems, decision.modelItems[0]] },
    ]) expect(() => validateTaskDecisionProposal(invalid as TaskDecisionProposal, input)).toThrow();
  });

  it("allows one state update to share ending provenance but not executable work or duplicate updates", () => {
    const input = createControllerInput();
    const final = modelCall("final-with-state", "product_end", 0);
    const update = {kind: "state_transition" as const, transition: "plan_update" as const,
      input: {plan: [{step: "Unfinished", status: "pending"}]}, modelCallRef: final.modelCallRef};
    const decision: TaskDecisionProposal = {kind: "propose_completion", output: {summary: "Partial"},
      completionSource: {kind: "model_call", modelCallRef: final.modelCallRef},
      candidates: [update], modelItems: modelCallItems([final])};
    expect(validateTaskDecisionProposal(decision, input)).toMatchObject(decision);
    expect(() => validateTaskDecisionProposal({...decision, candidates: [update, update]}, input)).toThrow();
    expect(() => validateTaskDecisionProposal({...decision, candidates: [{kind: "tool_request", modelCallRef: final.modelCallRef,
      tool: {name: "workspace.writeFile", revision: "1", input: {}, origin: "model", controllerRequestId: "request-1"}}]}, input)).toThrow();
    expect(() => validateTaskDecisionProposal({...decision, candidates: [{...update, transition: "handoff"}]} as unknown as TaskDecisionProposal, input)).toThrow();
  });

  it("preserves trusted workflow provenance in generic Controller validation", () => {
    const input = createControllerInput();
    const call = modelCall("workflow_item_1", "workspace.createFile", 0);
    const result = validateTaskDecisionProposal({
      kind: "advance",
      candidates: [{
        kind: "tool_request",
        tool: {
          name: "workspace.createFile",
          revision: null,
          input: { path: "created.txt", content: "" },
          origin: "workflow",
          controllerRequestId: null,
        },
        modelCallRef: call.modelCallRef,
      }],
      modelItems: modelCallItems([call]),
    }, input);

    expect(result).toMatchObject({
      kind: "advance",
      candidates: [{
        kind: "tool_request",
        tool: { origin: "workflow", controllerRequestId: null },
      }],
    });
  });

  it("rejects trusted workflow provenance at the Provider-backed boundary", async () => {
    const controller = createController(
      new FakeProvider({ results: [succeededResult({ action: "create" })] }),
      {
        parseResponse() {
          const call = modelCall("model_item_1", "workspace.createFile", 0);
          return {
            kind: "advance",
            candidates: [{
              kind: "tool_request",
              tool: {
                name: "workspace.createFile",
                revision: null,
                input: { path: "created.txt", content: "" },
                origin: "workflow",
                controllerRequestId: null,
              },
              modelCallRef: call.modelCallRef,
            }],
            modelItems: modelCallItems([call]),
          };
        },
      },
    );

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect(error).toBeInstanceOf(TaskDecisionActivityError);
    expect((error as TaskDecisionActivityError).failure.failure).toMatchObject({
      code: "model_output_invalid",
      metadata: {
        structuredOutputFailureCode: "controller_provider_tool_provenance_invalid",
      },
    });
  });

  it("preserves a normal completion output without imposing business interpretation", async () => {
    const controller = createController(
      new FakeProvider({ results: [succeededResult({ action: "complete" })] }),
      {
        parseResponse() {
          return { candidates: [], completionSource: {kind: "controller" as const},
            kind: "propose_completion",
            output: { summary: "  No safe next action.  " },
            modelItems: modelItems("model_item_1", { action: "complete" }),
          };
        },
      },
    );

    await expect(
      controller.next(createControllerInput(), callContext()),
    ).resolves.toMatchObject({
      kind: "propose_completion",
      output: { summary: "  No safe next action.  " },
    });
  });

  it("maps failed provider responses to attributed ControllerError values", async () => {
    const controller = createController(
      new FakeProvider({
        results: [
          {
            kind: "failed",
            failure: {
              category: "transport",
              code: "upstream_unavailable",
              message: "Provider unavailable.",
              metadata: {},
            },
          },
        ],
      }),
    );

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect(error).toBeInstanceOf(TaskDecisionActivityError);
    expect((error as TaskDecisionActivityError).failure.kind).toBe("provider");
    expect((error as TaskDecisionActivityError).failure.failure).toEqual({
      category: "transport",
      code: "provider_request_failed",
      message: "Provider unavailable.",
      metadata: {
        providerId: "fake-provider",
        providerFailureCategory: "transport",
        providerErrorCode: "upstream_unavailable",
        providerRequestId: null,
        providerStatusCode: null,
        providerRetryAfterMs: null,
      },
    });
  });

  it("preserves Provider timeout as an owner-specific failure", async () => {
    const controller = createController(new FakeProvider({
      results: [{
        kind: "failed",
        failure: {
          category: "timeout",
          code: "provider_timeout",
          message: "Provider request timed out.",
          metadata: {},
        },
      }],
    }));

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect((error as TaskDecisionActivityError).failure.kind).toBe("provider");
    expect((error as TaskDecisionActivityError).failure.failure).toMatchObject({
      code: "provider_timeout",
      metadata: {
        providerFailureCategory: "timeout",
        providerErrorCode: "provider_timeout",
      },
    });
  });

  it("preserves context-window rejection and does not retry the same request", async () => {
    const provider = new FakeProvider({
      results: [{
        kind: "failed",
        failure: {
          category: "invalid_request",
          code: "provider_context_window_exceeded",
          message: "Provider context window exceeded.",
          statusCode: 400,
          metadata: {},
        },
      }],
    });
    const controller = createController(provider);

    const error = await captureError(controller.next(
      createControllerInput(),
      callContext(undefined, {
        maxRetries: 3,
        retryableCategories: ["transport", "timeout", "rate_limit", "server_error"],
      }),
    ));

    expect(provider.requests()).toHaveLength(1);
    expect((error as TaskDecisionActivityError).failure.failure).toMatchObject({
      code: "provider_context_window_exceeded",
      metadata: {
        providerFailureCategory: "invalid_request",
        providerErrorCode: "provider_context_window_exceeded",
        providerStatusCode: 400,
      },
    });
  });

  it("retries a safe transport failure with one stable operation and fresh requests", async () => {
    const requests: ProviderRequest[] = [];
    const events: Array<Record<string, unknown>> = [];
    const buildRequest = vi.fn(() => request("original request"));
    const provider: Provider = {
      descriptor: providerDescriptor("retrying-provider"),
      async send(candidate) {
        requests.push(candidate);
        if (requests.length === 1) {
          expect(Object.isFrozen(candidate.messages)).toBe(true);
          expect(Object.isFrozen(candidate.messages[0]?.content)).toBe(true);
          return failedResult("transport", "network_unavailable");
        }
        return succeededResult({ summary: "Recovered" });
      },
    };
    const controller = createController(provider, {
      buildRequest,
      parseResponse: (response) => finalDecision(providerGeneratedOutput(response)),
    });

    const result = await controller.next(
      createControllerInput(),
      callContext(undefined, {
        maxRetries: 1,
        retryableCategories: ["transport"],
        events,
      }),
    );

    expect(result).toMatchObject({ kind: "propose_completion", output: { summary: "Recovered" } });
    expect(buildRequest).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toBe(requests[1]);
    expect(requests[1].messages[0]?.content).toEqual([
      { kind: "text", text: "original request" },
    ]);
    const providerEvents = events.filter((event) => event.owner === "provider_request");
    expect(providerEvents.map((event) => event.type)).toEqual([
      "retry_attempt_started",
      "retry_attempt_finished",
      "retry_scheduled",
      "retry_attempt_started",
      "retry_attempt_finished",
    ]);
    expect(new Set(providerEvents.map((event) => event.operationId))).toEqual(new Set([
      "run_001:controller:1:provider-request:1",
    ]));
    expect(providerEvents[0].attemptId).not.toBe(providerEvents[3].attemptId);
  });

  it.each([
    [429, "rate_limit"],
    [503, "server_error"],
    [408, "timeout"],
  ])("retries technically safe HTTP %s as %s", async (statusCode, category) => {
    const events: Array<Record<string, unknown>> = [];
    const provider = new FakeProvider({
      results: [
        failedResult("http", "provider_http_error", { statusCode, retryAfterMs: 0 }),
        succeededResult({ summary: "Recovered" }),
      ],
    });
    const controller = createController(provider);

    await controller.next(createControllerInput(), callContext(undefined, {
      maxRetries: 1,
      retryableCategories: [category],
      serverDelay: { mode: "prefer_trusted", maxServerDelayMs: 1_000 },
      events,
    }));

    expect(provider.requests()).toHaveLength(2);
    expect(events.find((event) => event.type === "retry_scheduled")).toMatchObject({
      failureCategory: category,
      delaySource: "trusted_server_delay",
    });
  });

  it.each(["timeout", "rate_limit", "server_error"])(
    "retries an adapter-normalized %s failure without an HTTP status",
    async (category) => {
      const provider = new FakeProvider({
        results: [
          failedResult(category, `provider_${category}`),
          succeededResult({ summary: "Recovered" }),
        ],
      });

      await createController(provider).next(
        createControllerInput(),
        callContext(undefined, {
          maxRetries: 1,
          retryableCategories: [category],
        }),
      );

      expect(provider.requests()).toHaveLength(2);
    },
  );

  it("does not retry a non-retryable authentication failure", async () => {
    const provider = new FakeProvider({
      results: [failedResult("http", "provider_http_error", { statusCode: 401 })],
    });
    const controller = createController(provider);

    const error = await captureError(controller.next(
      createControllerInput(),
      callContext(undefined, {
        maxRetries: 3,
        retryableCategories: ["transport", "timeout", "rate_limit", "server_error"],
      }),
    ));

    expect(provider.requests()).toHaveLength(1);
    expect((error as TaskDecisionActivityError).failure.failure).toMatchObject({
      code: "provider_request_failed",
      metadata: { providerFailureCategory: "authentication", providerStatusCode: 401 },
    });
  });

  it("maps exact budget consumption to provider_retry_exhausted", async () => {
    const events: Array<Record<string, unknown>> = [];
    const provider = new FakeProvider({
      results: [
        failedResult("transport", "network_unavailable"),
        failedResult("transport", "network_unavailable"),
        failedResult("transport", "network_unavailable"),
      ],
    });
    const controller = createController(provider);

    const error = await captureError(controller.next(
      createControllerInput(),
      callContext(undefined, {
        maxRetries: 2,
        retryableCategories: ["transport"],
        events,
      }),
    ));

    expect(provider.requests()).toHaveLength(3);
    expect((error as TaskDecisionActivityError).failure.failure).toMatchObject({
      code: "provider_retry_exhausted",
      metadata: {
        retryExhaustionReason: "retry_budget_exhausted",
        retryTotalAttempts: 3,
        providerFailureCategory: "transport",
      },
    });
    expect(events.find((event) =>
      event.owner === "provider_request" && event.type === "retry_exhausted"
    )).toMatchObject({
      type: "retry_exhausted",
      reason: "retry_budget_exhausted",
      totalAttempts: 3,
    });
  });

  it("stops at the absolute operation deadline without Run cancellation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-14T00:00:00.000Z");
    const events: Array<Record<string, unknown>> = [];
    const provider: Provider = {
      descriptor: providerDescriptor("deadline-provider"),
      async send(_request, context) {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        expect(context.interruption).toMatchObject({ kind: "operation_deadline" });
        return failedResult("deadline", "provider_operation_deadline");
      },
    };
    const controller = createController(provider);
    const run = captureError(controller.next(createControllerInput(), callContext(undefined, {
      maxRetries: 2,
      retryableCategories: ["transport", "timeout"],
      deadlineAt: "2026-07-14T00:00:00.025Z",
      events,
    })));

    await vi.advanceTimersByTimeAsync(25);
    const error = await run;

    expect((error as TaskDecisionActivityError).failure.failure).toMatchObject({
      code: "provider_operation_deadline_exceeded",
      metadata: { retryExhaustionReason: "deadline_exceeded", retryTotalAttempts: 1,
        lastFailure: {code: "provider_operation_deadline"} },
    });
    expect((error as TaskDecisionActivityError).deadline).toMatchObject({
      owner: "provider_request", deadlineAt: "2026-07-14T00:00:00.025Z", operationId: expect.any(String),
    });
    expect(events.filter((event) => event.owner === "provider_request")
      .map((event) => event.type)).toEqual([
      "retry_attempt_started",
      "retry_attempt_finished",
      "retry_exhausted",
    ]);
  });

  it("cancels during Provider backoff without starting another attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-14T00:00:00.000Z");
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const events: Array<Record<string, unknown>> = [];
    const provider = new FakeProvider({
      results: [
        failedResult("transport", "network_unavailable"),
        succeededResult({ summary: "must not run" }),
      ],
    });
    const controller = createController(provider);
    const run = controller.next(createControllerInput(), callContext(cancellation.context, {
      maxRetries: 1,
      retryableCategories: ["transport"],
      baseDelayMs: 1_000,
      maxDelayMs: 1_000,
      deadlineAt: "2026-07-14T00:00:10.000Z",
      events,
    }));
    await waitForRetryEvent(events, "retry_scheduled");
    const outcome = captureError(run);
    const receipt = cancellation.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });

    await expect(outcome).resolves.toBe(receipt.request);
    expect(provider.requests()).toHaveLength(1);
    expect(events.find((event) =>
      event.owner === "provider_request" && event.type === "retry_cancelled"
    )).toMatchObject({ type: "retry_cancelled", phase: "backoff" });
  });

  it("rejects SDK-owned request Retry without a conforming projection path", () => {
    const provider = new FakeProvider({
      descriptor: {
        requestRetryScheduler: {
          kind: "sdk",
          sdkName: "example-sdk",
          maxAttempts: 3,
          exposesAttemptEvents: false,
          supportsCancellation: true,
        },
      },
    });

    expect(() => createController(provider)).toThrow(
      "requires Harness-owned Provider request Retry",
    );
  });

  it("accepts only cancellation correlated to the active Run request", async () => {
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const provider: Provider = {
      descriptor: providerDescriptor("cancelling-provider"),
      async send(_request, context) {
        const receipt = cancellation.requestCancellation({
          origin: "host",
          reasonCode: "host_requested",
        });
        expect(context.interruption).toEqual({
          kind: "run_cancellation",
          cancellation: {
            runId: "run_001",
            requestId: receipt.request.id,
          },
        });
        return {
          kind: "cancelled",
          cancellation: {
            runId: "run_001",
            requestId: receipt.request.id,
          },
        };
      },
    };
    const controller = createController(provider);

    const error = await captureError(controller.next(createControllerInput(), {
      ...callContext(cancellation.context),
    }));

    expect(error).toBe(cancellation.context.request);
  });

  it("fails closed for mismatched or unconfirmed Provider cancellation", async () => {
    const mismatched = createController(new FakeProvider({
      results: [{
        kind: "cancelled",
        cancellation: { runId: "another_run", requestId: "unknown_request" },
      }],
    }));
    const unconfirmed = createController(new FakeProvider({
      results: [{
        kind: "cancellation_unconfirmed",
        failure: {
          category: "cancellation",
          code: "provider_cancellation_unconfirmed",
          message: "Provider settlement could not be confirmed.",
          metadata: {},
        },
      }],
    }));

    const mismatchedError = await captureError(
      mismatched.next(createControllerInput(), callContext()),
    );
    const unconfirmedError = await captureError(
      unconfirmed.next(createControllerInput(), callContext()),
    );

    expect((mismatchedError as TaskDecisionActivityError).failure.failure.code)
      .toBe("provider_cancellation_unconfirmed");
    expect((unconfirmedError as TaskDecisionActivityError).failure.kind).toBe("provider");
    expect((unconfirmedError as TaskDecisionActivityError).failure.failure).toMatchObject({
      code: "provider_cancellation_unconfirmed",
      message: "Provider settlement could not be confirmed.",
    });
  });

  it("does not expose thrown provider messages as runtime error messages", async () => {
    const controller = createController(throwingProvider());

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect(error).toBeInstanceOf(TaskDecisionActivityError);
    expect((error as TaskDecisionActivityError).failure.kind).toBe("provider");
    expect((error as TaskDecisionActivityError).failure.failure).toMatchObject({
      code: "provider_request_failed",
      message: "Provider request failed.",
      metadata: {
        providerId: "throwing-provider",
        causeName: "Error",
      },
    });
  });

  it("attributes request construction failures to the model request boundary", async () => {
    const controller = createController(new FakeProvider(), {
      buildRequest() {
        throw new TypeError("Prompt assembly failed.");
      },
    });

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect((error as TaskDecisionActivityError).failure.kind).toBe("model");
    expect((error as TaskDecisionActivityError).failure.failure).toMatchObject({
      code: "model_request_failed",
      message: "Prompt assembly failed.",
    });
  });

  it("rejects oversized provider output before product parsing", async () => {
    const parseResponse = vi.fn(() => finalDecision({ summary: "unused" }));
    const controller = createController(
      new FakeProvider({ results: [succeededResult("123456")] }),
      { parseResponse, maxProviderOutputLength: 5 },
    );

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect(parseResponse).not.toHaveBeenCalled();
    expect((error as TaskDecisionActivityError).failure.kind).toBe("model");
    expect((error as TaskDecisionActivityError).failure.failure).toMatchObject({
      code: "model_output_invalid",
      message: "Model output did not satisfy the active structured-output contract.",
      metadata: {
        structuredOutputFailureCategory: "structured_output_size",
        structuredOutputFailureCode: "structured_output_too_large",
      },
    });
  });

  it("rejects parser failures and Agent output contract failures", async () => {
    const parseFailure = createController(
      new FakeProvider({ results: [succeededResult({ malformed: true })] }),
      {
        parseResponse() {
          throw new SyntaxError("Expected action kind.");
        },
      },
    );
    const outputFailure = createController(
      new FakeProvider({ results: [succeededResult({ summary: 42 })] }),
      {
        parseResponse(response) {
          return finalDecision(providerGeneratedOutput(response));
        },
      },
    );

    const parseError = await captureError(
      parseFailure.next(createControllerInput(), callContext()),
    );
    const outputError = await captureError(
      outputFailure.next(createControllerInput(), callContext()),
    );

    expect((parseError as TaskDecisionActivityError).failure.failure).toMatchObject({
      code: "model_output_invalid",
      message: "Provider output parsing failed.",
    });
    expect((outputError as TaskDecisionActivityError).failure.failure).toMatchObject({
      code: "model_output_invalid",
      message: "Model output did not satisfy the active structured-output contract.",
      metadata: {
        structuredOutputFailureCategory: "agent_output_contract",
        structuredOutputFailureCode: "agent_output_invalid",
      },
    });
  });

  it("corrects one eligible structured-output failure within one stable operation", async () => {
    const rawInvalidOutput = "raw invalid output with private content";
    const buildContexts: ProviderRequestBuildContext[] = [];
    const events: Array<Record<string, unknown>> = [];
    const provider = new FakeProvider({
      results: [
        succeededResult(rawInvalidOutput),
        succeededResult({ summary: "Recovered" }),
      ],
    });
    const controller = createController(provider, {
      buildRequest(_input, context) {
        buildContexts.push(context);
        return request(context.correction === null
          ? "Initial request"
          : `Correction: ${context.correction.failure.correctionFeedback}`);
      },
      parseResponse(response) {
        if (providerGeneratedOutput(response) === rawInvalidOutput) {
          throw correctionError(
            "structured_output_syntax",
            "test_output_not_json",
            "Return one valid structured object.",
          );
        }
        return finalDecision(providerGeneratedOutput(response));
      },
    });

    const decision = await controller.next(
      createControllerInput(),
      callContext(undefined, {
        structuredMaxRetries: 1,
        structuredRetryableCategories: ["structured_output_syntax"],
        events,
      }),
    );

    expect(decision).toMatchObject({
      kind: "propose_completion",
      output: { summary: "Recovered" },
    });
    expect(provider.requests()).toHaveLength(2);
    expect(buildContexts).toHaveLength(2);
    expect(buildContexts[0]).toMatchObject({ attemptNumber: 1, correction: null });
    expect(buildContexts[1]).toMatchObject({
      attemptNumber: 2,
      correction: {
        previousAttemptNumber: 1,
        failure: {
          category: "structured_output_syntax",
          code: "test_output_not_json",
          correctionFeedback: "Return one valid structured object.",
        },
      },
    });
    expect(JSON.stringify(buildContexts[1])).not.toContain(rawInvalidOutput);
    expect(provider.requests()[1].messages[0].content).not.toContain(rawInvalidOutput);

    const structuredEvents = events.filter((event) => event.owner === "structured_output");
    expect(structuredEvents.map((event) => event.type)).toEqual([
      "retry_attempt_started",
      "retry_attempt_finished",
      "retry_scheduled",
      "retry_attempt_started",
      "retry_attempt_finished",
    ]);
    expect(new Set(structuredEvents.map((event) => event.operationId))).toEqual(
      new Set(["run_001:controller:1:structured-output:1"]),
    );
    expect(new Set(events
      .filter((event) => event.owner === "provider_request")
      .map((event) => event.operationId))).toEqual(new Set([
        "run_001:controller:1:provider-request:1",
        "run_001:controller:1:provider-request:2",
      ]));
  });

  it("corrects an Agent output-contract failure before returning a decision", async () => {
    const provider = new FakeProvider({
      results: [
        succeededResult({ summary: 42 }),
        succeededResult({ summary: "Recovered" }),
      ],
    });
    const controller = createController(provider, {
      parseResponse(response) {
        return finalDecision(providerGeneratedOutput(response));
      },
    });

    const decision = await controller.next(
      createControllerInput(),
      callContext(undefined, {
        structuredMaxRetries: 1,
        structuredRetryableCategories: ["agent_output_contract"],
      }),
    );

    expect(provider.requests()).toHaveLength(2);
    expect(decision).toMatchObject({
      kind: "propose_completion",
      output: { summary: "Recovered" },
    });
  });

  it("does not retry an untyped parser exception as a model correction", async () => {
    const provider = new FakeProvider({
      results: [succeededResult("invalid-1"), succeededResult("invalid-2")],
    });
    const controller = createController(provider, {
      parseResponse() {
        throw new SyntaxError("Parser implementation failed.");
      },
    });

    const error = await captureError(controller.next(
      createControllerInput(),
      callContext(undefined, {
        structuredMaxRetries: 1,
        structuredRetryableCategories: [
          "structured_output_syntax",
          "structured_output_schema",
        ],
      }),
    ));

    expect(provider.requests()).toHaveLength(1);
    expect((error as TaskDecisionActivityError).failure.kind).toBe("model");
    expect((error as TaskDecisionActivityError).failure.failure).toMatchObject({
      code: "model_output_invalid",
      message: "Provider output parsing failed.",
    });
  });

  it("maps repeated eligible output failures to structured-output exhaustion", async () => {
    const events: Array<Record<string, unknown>> = [];
    const provider = new FakeProvider({
      results: [succeededResult("invalid-1"), succeededResult("invalid-2")],
    });
    const controller = createController(provider, {
      parseResponse() {
        throw correctionError(
          "structured_output_schema",
          "test_schema_invalid",
          "Return the required summary field.",
        );
      },
    });

    const error = await captureError(controller.next(
      createControllerInput(),
      callContext(undefined, {
        structuredMaxRetries: 1,
        structuredRetryableCategories: ["structured_output_schema"],
        events,
      }),
    ));

    expect(provider.requests()).toHaveLength(2);
    expect((error as TaskDecisionActivityError).failure.kind).toBe("model");
    expect((error as TaskDecisionActivityError).failure.failure).toMatchObject({
      code: "model_structured_output_retry_exhausted",
      metadata: {
        retryExhaustionReason: "retry_budget_exhausted",
        retryTotalAttempts: 2,
        structuredOutputFailureCategory: "structured_output_schema",
        structuredOutputFailureCode: "test_schema_invalid",
      },
    });
    expect(events.find((event) =>
      event.owner === "structured_output" && event.type === "retry_exhausted"
    )).toMatchObject({ reason: "retry_budget_exhausted", totalAttempts: 2 });
  });

  it("preserves a Provider-owned failure during a correction request", async () => {
    const provider = new FakeProvider({
      results: [
        succeededResult("invalid"),
        failedResult("http", "provider_http_error", { statusCode: 401 }),
      ],
    });
    const controller = createController(provider, {
      parseResponse() {
        throw correctionError(
          "structured_output_syntax",
          "test_output_not_json",
          "Return valid structured output.",
        );
      },
    });

    const error = await captureError(controller.next(
      createControllerInput(),
      callContext(undefined, {
        structuredMaxRetries: 1,
        structuredRetryableCategories: ["structured_output_syntax"],
      }),
    ));

    expect(provider.requests()).toHaveLength(2);
    expect((error as TaskDecisionActivityError).failure.kind).toBe("provider");
    expect((error as TaskDecisionActivityError).failure.failure).toMatchObject({
      code: "provider_request_failed",
      metadata: {
        providerFailureCategory: "authentication",
        providerStatusCode: 401,
      },
    });
  });

  it("starts no correction attempt when cancellation wins during parsing", async () => {
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const provider = new FakeProvider({ results: [succeededResult("invalid")] });
    const controller = createController(provider, {
      parseResponse() {
        cancellation.requestCancellation({
          origin: "user",
          reasonCode: "user_requested",
        });
        throw correctionError(
          "structured_output_syntax",
          "test_output_not_json",
          "Return valid structured output.",
        );
      },
    });

    const error = await captureError(controller.next(
      createControllerInput(),
      callContext(cancellation.context, {
        structuredMaxRetries: 1,
        structuredRetryableCategories: ["structured_output_syntax"],
      }),
    ));

    expect(error).toBe(cancellation.context.request);
    expect(provider.requests()).toHaveLength(1);
  });

  it("does not schedule a correction beyond the absolute Run deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-14T00:00:00.000Z");
    const provider = new FakeProvider({ results: [succeededResult("invalid")] });
    const controller = createController(provider, {
      parseResponse() {
        throw correctionError(
          "structured_output_syntax",
          "test_output_not_json",
          "Return valid structured output.",
        );
      },
    });

    const error = await captureError(controller.next(
      createControllerInput(),
      callContext(undefined, {
        structuredMaxRetries: 1,
        structuredRetryableCategories: ["structured_output_syntax"],
        structuredBaseDelayMs: 1_000,
        structuredMaxDelayMs: 1_000,
        deadlineAt: "2026-07-14T00:00:00.025Z",
      }),
    ));

    expect(provider.requests()).toHaveLength(1);
    expect((error as TaskDecisionActivityError).failure.failure).toMatchObject({
      code: "model_operation_deadline_exceeded",
      metadata: {
        retryExhaustionReason: "deadline_exceeded",
        retryTotalAttempts: 1,
      },
    });
    expect((error as TaskDecisionActivityError).deadline).toMatchObject({owner: "structured_output", deadlineAt: "2026-07-14T00:00:00.025Z"});
  });

  it.each([
    ["empty model items", { ...finalDecision({ summary: "Done" }), modelItems: [] }],
    [
      "duplicate model item ids",
      {
        ...finalDecision({ summary: "Done" }),
        modelItems: duplicateModelItems(),
      },
    ],
    [
      "unknown action provenance",
      {
        kind: "actions",
        actions: [
          {
            kind: "tool",
            name: "workspace.readFile",
            input: {},
            modelCallRef: modelCall("missing", "workspace.readFile", 0).modelCallRef,
          },
        ],
        modelItems: modelItems("model_item_1", {}),
      },
    ],
    [
      "empty actions",
      {
        kind: "actions",
        actions: [],
        modelItems: modelItems("model_item_1", {}),
      },
    ],
    [
      "empty stop reason",
      {
        kind: "stop",
        reason: " ",
        modelItems: modelItems("model_item_1", {}),
      },
    ],
    [
      "unsupported decision kind",
      {
        kind: "handoff",
        modelItems: modelItems("model_item_1", {}),
      },
    ],
  ])("rejects malformed decision: %s", async (_name, malformedDecision) => {
    const controller = createController(
      new FakeProvider({ results: [succeededResult({})] }),
      {
        parseResponse() {
          return malformedDecision as unknown as TaskDecisionProposal<TestOutput>;
        },
      },
    );

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect(error).toBeInstanceOf(TaskDecisionActivityError);
    expect((error as TaskDecisionActivityError).failure.failure.code).toBe("model_output_invalid");
  });

  it("does not start provider work after cancellation", async () => {
    const provider = new FakeProvider({ results: [succeededResult({})] });
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const receipt = cancellation.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });
    const controller = createController(provider);

    const error = await captureError(
      controller.next(createControllerInput(), {
        ...callContext(cancellation.context),
      }),
    );

    expect(error).toBe(receipt.request);
    expect(provider.requests()).toEqual([]);
  });

  it("discards a provider response when cancellation wins during the active call", async () => {
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const parseResponse = vi.fn(() => finalDecision({ summary: "unused" }));
    const provider: Provider = {
      descriptor: providerDescriptor("cancelling-provider"),
      async send() {
        cancellation.requestCancellation({
          origin: "host",
          reasonCode: "host_requested",
        });
        return succeededResult({ summary: "Too late" });
      },
    };
    const controller = createController(provider, { parseResponse });

    const error = await captureError(
      controller.next(createControllerInput(), {
        ...callContext(cancellation.context),
      }),
    );

    expect(error).toBe(cancellation.context.request);
    expect(parseResponse).not.toHaveBeenCalled();
  });

  it("requires a positive integer provider output limit", () => {
    expect(
      () =>
        createController(new FakeProvider(), {
          maxProviderOutputLength: 0,
        }),
    ).toThrow("maxProviderOutputLength must be a positive integer.");
  });
});

describe("ModelTaskDecisionCoordinator native streaming", () => {
  function setup(input: {
    readonly send: Provider["send"];
    readonly events: ModelResponseObservation[];
    readonly continuation?: boolean;
    readonly maximumOutputRecoveryAttempts?: number;
    readonly parseResponse?: (response: ProviderResponse) => TaskDecisionProposal<TestOutput>;
  }) {
    const base = new FakeProvider({ results: [] });
    const provider: Provider = {
      descriptor: { ...base.descriptor, capabilities: { ...base.descriptor.capabilities,
        continuation: input.continuation ? { supported: true, mechanism: "response_chaining", supportsCompaction: false }
          : { supported: false },
        streaming: { supported: true }, nativeToolInteraction: {
          supported: true, callableDefinitions: true, modelCalls: true, resultMessages: true,
          multipleCalls: true, callCorrelation: "adapter_assigned",
        },
      } },
      modelContext: base.modelContext, requestBodyTransportLimit: base.requestBodyTransportLimit,
      send: input.send,
    };
    return new ModelTaskDecisionCoordinator<TestOutput>({
      provider, responseProtocol: { kind: "native_tool_turn", maximumOutputRecoveryAttempts: input.maximumOutputRecoveryAttempts },
      delivery: { mode: "streaming", observer: { observe(event) { input.events.push(event); } } },
      buildRequest(input, context) {
        return accountTestRequest({ ...request("Continue"), interaction: createNativeToolTurnInteraction([
          { name: "Read", description: "Read a file.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
        ]) }, provider, input, context);
      },
      parseResponse: input.parseResponse ?? ((response) => {
        if (response.kind !== "native_tool_turn") throw new Error("Expected native turn");
        return { candidates: [], completionSource: {kind: "controller" as const}, kind: "propose_completion", output: { summary: "Done" }, modelItems: createControllerModelItems(response.turn) };
      }),
      retryExecutor: createSystemRetryExecutor(), retryClock: systemRetryClock,
    });
  }
  function complete(request: ProviderRequest): ProviderCallResult {
    return { kind: "succeeded", response: { kind: "native_tool_turn", continuation: null, metadata: {}, turn: {
      turnId: "stream-turn", assistant: { role: "assistant", content: [{ kind: "text", text: "Done" }] },
      finish: { kind: "normal" }, usage: null,
      responseRef: { providerId: "fake-provider", requestId: request.requestId, responseId: null },
    } } };
  }

  it.each(["intent", "response", "settled"] as const)("recovers a native request after lost %s acknowledgement without resetting its allowance", async point => {
    const records = new Map<string, unknown>();
    let lost = false;
    let sent = 0;
    const checkpoints = {read: (key: string) => records.get(key) ?? null,
      async commit(key: string, value: unknown) {
        records.set(key, structuredClone(value));
        const retry = (value as {value?: {attempt?: unknown; attemptResult?: unknown; outcome?: unknown}}).value;
        const hit = key.includes(":retry:") && (point === "intent" ? retry?.attempt && !retry.attemptResult
          : point === "response" ? retry?.attemptResult : retry?.outcome);
        if (hit && !lost) {lost = true; throw new Error("lost acknowledgement");}
      }};
    const controller = setup({events: [], async send(request) {sent++; return complete(request);}});
    const context = {...callContext(undefined, {maxRetries: 1, retryableCategories: ["transport"]}), checkpoints};
    await expect(controller.next(createControllerInput(), context)).rejects.toMatchObject({name: "RetryCheckpointError"});
    expect(lost).toBe(true);
    expect((await controller.recover(createControllerInput(), context)).kind).toBe("propose_completion");
    expect(sent).toBe(1);
    const retry = [...records.values()].map(value => (value as {value: Record<string, unknown>}).value)
      .find(value => value.attempt && value.outcome) as {attempt: {attemptNumber: number}};
    expect(retry.attempt.attemptNumber).toBe(point === "intent" ? 2 : 1);
  });

  it("does not interpret partial output and maps accepted text to validated model items", async () => {
    const events: ModelResponseObservation[] = [];
    const release = Promise.withResolvers<void>();
    const parse = vi.fn((response: ProviderResponse): TaskDecisionProposal<TestOutput> => {
      if (response.kind !== "native_tool_turn") throw new Error("Expected native turn");
      return { candidates: [], completionSource: {kind: "controller" as const}, kind: "propose_completion", output: { summary: "Done" }, modelItems: createControllerModelItems(response.turn) };
    });
    const controller = setup({ events, parseResponse: parse, async send(request, _context, options) {
      expect(options?.mode).toBe("streaming");
      const delivery = new ProviderDeliverySession(options!, request);
      delivery.start(); delivery.text("Do");
      await release.promise;
      delivery.text("ne");
      const result = complete(request);
      delivery.settle(result);
      return result;
    } });
    const pending = controller.next(createControllerInput(), callContext());
    void pending.catch(() => {});
    await vi.waitFor(() => expect(events.some((event) => event.kind === "delivery" && event.progress.kind === "text_delta")).toBe(true));
    expect(parse).not.toHaveBeenCalled();
    release.resolve();
    expect((await pending).kind).toBe("propose_completion");
    expect(parse).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ kind: "interpretation", disposition: "validated", parts: [
      { partId: "text:0", turnId: "stream-turn", contentBlockOrdinal: 0, modelItemId: "stream-turn:content:0" },
    ] });
  });

  it.each(["http", "cancellation_unconfirmed", "invalid_metadata"])("persists and reuses Provider failure (%s) before deciding its disposition", async kind => {
    const records = new Map<string, unknown>();
    let sent = 0, interrupted = false;
    const failure = {category: "http", code: "provider_http_error", message: "Rejected", statusCode: 400,
      retryAfterMs: undefined, requestId: undefined, metadata: kind === "invalid_metadata" ? {bad: new Date()} : {detail: "saved"}};
    const coordinator = setup({events: [], async send() {sent++; return {
      kind: kind === "cancellation_unconfirmed" ? "cancellation_unconfirmed" : "failed", failure,
    } as unknown as ProviderCallResult;}});
    const checkpoints = {read: (key: string) => records.get(key) ?? null, async commit(key: string, value: unknown) {
      records.set(key, structuredClone(value));
      const checkpoint = (value as {value?: {attemptResult?: {kind: string}}}).value;
      if (key.includes(":retry:") && checkpoint?.attemptResult?.kind === "failed" && !interrupted) {
        interrupted = true; throw new Error("lost failure acknowledgement");
      }
    }};
    const context = {...callContext(), checkpoints};
    await expect(coordinator.next(createControllerInput(), context)).rejects.toMatchObject({name: "RetryCheckpointError"});
    expect(interrupted).toBe(true);
    await expect(coordinator.recover(createControllerInput(), context)).rejects.toMatchObject({name: "TaskDecisionActivityError"});
    expect(sent).toBe(1);
    const saved = [...records.values()].map(record => (record as {value: any}).value)
      .find(value => value.attemptResult?.error?.failure)?.attemptResult.error.failure;
    expect(saved.code).toBe(kind === "invalid_metadata" ? "provider_result_contract_invalid" : "provider_http_error");
    expect(Object.hasOwn(saved, "retryAfterMs")).toBe(false);
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
  });

  it("retries transport interruptions under separate invocation identities without combining previews", async () => {
    const events: ModelResponseObservation[] = [];
    const retries: Record<string, unknown>[] = [];
    const ids: string[] = [];
    const controller = setup({ events, async send(request, _context, options) {
      ids.push(options!.invocationId);
      const delivery = new ProviderDeliverySession(options!, request);
      delivery.start(); delivery.text(ids.length === 1 ? "Discarded" : "Done");
      const result: ProviderCallResult = ids.length === 1
        ? { kind: "failed", failure: { category: "transport", code: "provider_response_incomplete", message: "EOF", metadata: {} } }
        : complete(request);
      delivery.settle(result);
      return result;
    } });
    await controller.next(createControllerInput(), callContext(undefined, { maxRetries: 1, retryableCategories: ["transport"], events: retries }));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(JSON.stringify(retries)).toContain(ids[0]);
    expect(JSON.stringify(retries)).toContain(ids[1]);
    expect(events.filter((event) => event.kind === "delivery" && event.progress.kind === "settled")
      .map((event) => event.kind === "delivery" && event.progress.kind === "settled" && event.progress.disposition))
      .toEqual(["interrupted", "completed"]);
    expect(events.filter((event) => event.kind === "interpretation")).toMatchObject([
      { disposition: "validated", invocationId: ids[1] },
    ]);
  });

  it("rejects a complete Provider response without making its preview authoritative", async () => {
    const events: ModelResponseObservation[] = [];
    const controller = setup({ events, parseResponse() { throw new Error("invalid Product decision"); },
      async send(request, _context, options) {
        const delivery = new ProviderDeliverySession(options!, request);
        delivery.start(); delivery.text("Done");
        const result = complete(request); delivery.settle(result); return result;
      },
    });
    await expect(controller.next(createControllerInput(), callContext())).rejects.toBeDefined();
    expect(events.at(-1)).toMatchObject({ kind: "interpretation", disposition: "rejected", parts: [] });
  });

  function truncated(request: ProviderRequest): ProviderCallResult {
    const result = complete(request);
    if (result.kind !== "succeeded" || result.response.kind !== "native_tool_turn") throw new Error("Expected native turn");
    return { ...result, response: { ...result.response, turn: { ...result.response.turn,
      turnId: `truncated:${request.requestId}`,
      finish: { kind: "output_limit" },
      assistant: { role: "assistant", content: [{ kind: "text", text: "Rejected fragment" }, {
        kind: "model_tool_call", call: {
          modelCallRef: { controllerRequestId: request.correlation.controllerRequestId!, branchId: request.correlation.branchId!,
            turnId: `truncated:${request.requestId}`, contentBlockOrdinal: 1 },
          providerCallRef: null, name: "Read", input: {}, ordinal: 1,
        },
      }] },
    } } };
  }

  it("regenerates truncated output without interpreting any rejected calls or raising the output cap", async () => {
    const events: ModelResponseObservation[] = [];
    const requests: ProviderRequest[] = [];
    const controller = setup({ events, async send(request, _context, options) {
      requests.push(request);
      const session = new ProviderDeliverySession(options!, request);
      session.start(); session.text(requests.length === 1 ? "Rejected fragment" : "Done");
      const result = requests.length === 1 ? truncated(request) : complete(request);
      session.settle(result); return result;
    } });
    const result = await controller.next(createControllerInput(), callContext());
    expect(result.kind).toBe("propose_completion");
    expect(result.modelItems.some(item => item.kind === "model_tool_call")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("Rejected fragment");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId);
    expect(requests[1]!.instructions).toEqual(requests[0]!.instructions);
    expect(requests[1]!.interaction).toEqual(requests[0]!.interaction);
    expect(requests[1]!.modelContext.requestedOutput).toEqual(requests[0]!.modelContext.requestedOutput);
    expect(requests[1]!.modelContext.assessment?.compositionId).toBe(requests[1]!.composition.id);
    expect(requests[1]!.composition.sections.at(-1)).toMatchObject({ role: "user", kind: "model_output_recovery",
      content: { text: expect.stringContaining("None of its function calls were executed") } });
    expect(JSON.stringify(requests[1])).not.toContain("Rejected fragment");
    expect(events.filter(event => event.kind === "interpretation")).toMatchObject([
      { disposition: "rejected", parts: [] }, { disposition: "validated" },
    ]);
  });

  it("exhausts exactly two recovery requests and retains the concrete truncation diagnostic", async () => {
    const events: ModelResponseObservation[] = [];
    const requests: ProviderRequest[] = [];
    const controller = setup({ events, async send(request, _context, options) {
      requests.push(request);
      const session = new ProviderDeliverySession(options!, request);
      session.start(); session.text("Rejected fragment");
      const result = truncated(request); session.settle(result); return result;
    } });
    await expect(controller.next(createControllerInput(), callContext())).rejects.toMatchObject({
      failure: { kind: "model", failure: { code: "model_output_limit_exhausted", retryable: false,
        message: expect.stringContaining("3 generation attempts"),
        metadata: { finishKind: "output_limit", generationAttempts: 3, recoveryAttempts: 2 } } },
    });
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map(request => request.requestId)).size).toBe(3);
    expect(requests.map(request => request.composition.sections.filter(section => section.kind === "model_output_recovery").length))
      .toEqual([0, 1, 1]);
    expect(events.filter(event => event.kind === "interpretation").map(event => event.disposition))
      .toEqual(["rejected", "rejected", "rejected"]);
    expect(new Set(events.filter(event => event.kind === "interpretation").map(event => event.invocationId)).size).toBe(3);
  });

  it("can disable recovery and never treats foreign responses as recoverable truncation", async () => {
    const send = vi.fn(async (request: ProviderRequest) => truncated(request));
    const controller = setup({ events: [], maximumOutputRecoveryAttempts: 0, send });
    await expect(controller.next(createControllerInput(), callContext())).rejects.toMatchObject({
      failure: { failure: { code: "model_output_limit_exhausted", metadata: { generationAttempts: 1 } } },
    });
    expect(send).toHaveBeenCalledTimes(1);
    const foreign = vi.fn(async (request: ProviderRequest) => truncated({ ...request, requestId: "foreign-request" }));
    await expect(setup({ events: [], send: foreign }).next(createControllerInput(), callContext())).rejects.toMatchObject({
      failure: { failure: { code: "model_output_invalid" } },
    });
    expect(foreign).toHaveBeenCalledTimes(1);
  });

  it("does not regenerate after cancellation wins at a truncated response", async () => {
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const send = vi.fn(async (request: ProviderRequest) => {
      cancellation.requestCancellation({ origin: "host", reasonCode: "host_requested" });
      return truncated(request);
    });
    await expect(setup({ events: [], send }).next(createControllerInput(), callContext(cancellation.context))).rejects.toBeDefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not start another generation after the operation deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-14T00:00:00.000Z");
    const send = vi.fn(async (request: ProviderRequest) => {
      vi.setSystemTime("2026-07-14T00:00:00.100Z");
      return truncated(request);
    });
    await expect(setup({ events: [], send }).next(createControllerInput(), callContext(undefined, {
      deadlineAt: "2026-07-14T00:00:00.050Z",
    }))).rejects.toMatchObject({ failure: { failure: { code: "provider_operation_deadline_exceeded" } } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not reuse continuation state from a rejected truncated response", async () => {
    let count = 0;
    const controller = setup({ events: [], continuation: true, async send(request) {
      count += 1;
      expect(request.continuation).toBeNull();
      const result = count === 1 ? truncated(request) : complete(request);
      if (result.kind !== "succeeded" || result.response.kind !== "native_tool_turn") throw new Error("Expected native turn");
      return { ...result, response: { ...result.response,
        continuation: { kind: "opaque_provider_state", handle: `continuation-${count}`, sensitivity: "restricted" },
        turn: { ...result.response.turn, responseRef: { ...result.response.turn.responseRef, responseId: `response-${count}` } },
      } };
    } });
    await expect(controller.next(createControllerInput(), callContext())).resolves.toMatchObject({ kind: "propose_completion" });
    expect(count).toBe(2);
  });

  it("allocates a new native invocation when existing continuation is reset", async () => {
    const events: ModelResponseObservation[] = [];
    const ids: string[] = [];
    const controller = setup({ events, continuation: true, async send(request, _context, options) {
      ids.push(options!.invocationId);
      const delivery = new ProviderDeliverySession(options!, request);
      delivery.start();
      if (ids.length === 2) {
        expect(request.continuation).not.toBeNull();
        const result: ProviderCallResult = { kind: "continuation_rejected", continuationId: request.continuation!.id, providerCode: "expired" };
        delivery.settle(result); return result;
      }
      expect(request.continuation).toBeNull();
      const base = complete(request);
      if (base.kind !== "succeeded" || base.response.kind !== "native_tool_turn") throw new Error("Expected native turn");
      const result: ProviderCallResult = { ...base, response: { ...base.response,
        continuation: { kind: "opaque_provider_state", handle: `state-${ids.length}`, sensitivity: "restricted" },
        turn: { ...base.response.turn, responseRef: { ...base.response.turn.responseRef, responseId: `response-${ids.length}` } },
      } };
      delivery.text("Done"); delivery.settle(result); return result;
    } });
    await controller.next(createControllerInput(), callContext());
    await controller.next(createControllerInput(), callContext());
    expect(ids).toHaveLength(3);
    expect(ids[1]).not.toBe(ids[2]);
    expect(ids[2]).toContain(":provider-request:2:attempt:1");
    expect(events.at(-1)).toMatchObject({ kind: "interpretation", invocationId: ids[2], disposition: "validated" });
  });

  it("keeps structured generation buffered and rejects opt-in for an unsupported Provider", async () => {
    const provider = new FakeProvider({ results: [succeededResult({ summary: "Done" })] });
    const send = vi.spyOn(provider, "send");
    await createController(provider).next(createControllerInput(), callContext());
    expect(send.mock.calls[0]?.[2]).toMatchObject({ mode: "buffered", invocationId: expect.any(String) });
    expect(() => new ModelTaskDecisionCoordinator({
      provider, buildRequest: () => { throw new Error("unused"); }, parseResponse: () => finalDecision({ summary: "Done" }),
      responseProtocol: { kind: "native_tool_turn" }, delivery: { mode: "streaming" },
      retryExecutor: createSystemRetryExecutor(), retryClock: systemRetryClock,
    })).toThrow("streaming-capable Provider");
  });
});

function semanticProvider(verdict: "adequate" | "unknown" | "invalid") {
  const base = ensureTestProviderContext(new FakeProvider({results: []}));
  const requests: ProviderRequest[] = [];
  const capacity = {supported: true as const, unit: "tokens" as const, maximum: 40000, semantics: "input_and_output" as const,
    source: "host_configured" as const, providerId: base.descriptor.id, model: base.modelContext.target.model, revision: "test"};
  const requestedOutput = {unit: "tokens" as const, maximum: null, source: "unspecified" as const, revision: "test"};
  const provider: Provider = {...base, modelContext: {...base.modelContext, capacity, requestedOutput,
    accounting: {basis: {fixture: "semantic"}, inputUsage: "complete", outputUsage: "complete", defaultGenerationRoom: 30000, limitations: [],
      project: composition => createModelNativeInputFootprint({messages: composition.messages})},
    measure: (composition, measuredAt) => ({status: "measured", amount: JSON.stringify(composition.messages).length,
      estimator: {id: "test-character-cost", revision: "1", unit: "tokens", accuracy: "exact"}, uncertainty: {kind: "none"}, measuredAt, measuredCompositionId: composition.id})},
    descriptor: {...base.descriptor, capabilities: {...base.descriptor.capabilities, structuredGeneration: {supported: true},
      modelContext: {...base.descriptor.capabilities.modelContext, capacity, requestedOutput}}}, send: async request => {
      requests.push(request);
      if (request.purpose === "agent-control") return succeededResult({summary: "Done"});
      const payload = JSON.parse((request.messages[0]!.content[0] as {text: string}).text);
      const ids = payload.replacementSources.map((value: {id: string}) => value.id);
      return succeededResult(request.purpose === "context_generation" ? verdict === "invalid" ? {entries: []} :
        {entries: [{text: "The source is a long repetitive report, with no execution claimed.", sources: ids}], limitations: [], omittedDetails: ["Repeated detail text"]} :
        {findings: CONTEXT_ASSESSMENT_CRITERIA.map(criterion => ({criterion, verdict, reason: "Checked supplied source and background.", sources: ids})),
          inheritedDefects: [], introducedLoss: [], limitations: []});
    }};
  return {provider, requests};
}

function createController(
  provider: Provider,
  overrides: Partial<{
    buildRequest: (
      input: TaskDecisionInputSources<TestOutput>,
      context: ProviderRequestBuildContext,
    ) => TestProviderRequest;
    parseResponse: (
      response: ProviderResponse,
      input: TaskDecisionInputSources<TestOutput>,
    ) => TaskDecisionProposal<TestOutput>;
    maxProviderOutputLength: number;
    continuation: ModelContinuationLifecycle;
    contextPreparation: ContextRepresentationPreparationSupport;
    prepareRequest: (request: ProviderRequest) => ProviderRequest;
  }> = {},
): ModelTaskDecisionCoordinator<TestOutput> {
  const accountedProvider = ensureTestProviderContext(provider);
  const buildRequest = overrides.buildRequest ?? (() => request("Choose the next action."));
  return new ModelTaskDecisionCoordinator({
    provider: accountedProvider,
    buildRequest(input, context) {
      const value = accountTestRequest(
        buildRequest(input, context),
        accountedProvider,
        input,
        context,
      );
      return overrides.prepareRequest?.(value) ?? value;
    },
    parseResponse:
      overrides.parseResponse ?? (() => finalDecision({ summary: "Done" })),
    responseProtocol: {
      kind: "structured_output",
      contractId: "test-controller-output-v1",
      maxProviderOutputLength: overrides.maxProviderOutputLength ?? 10_000,
    },
    retryExecutor: createSystemRetryExecutor(),
    retryClock: systemRetryClock,
    continuation: overrides.continuation,
    contextPreparation: overrides.contextPreparation,
  });
}

function memoryCheckpoints(): ActivityCheckpointPort {
  const values = new Map<string, unknown>();
  return {read: key => structuredClone(values.get(key) ?? null), commit: async (key, value) => {values.set(key, structuredClone(value));},
    compareAndCommit: async (expected, writes) => {
      for (const item of expected) expect(values.get(item.key) ?? null).toEqual(item.value);
      for (const item of writes) values.set(item.key, structuredClone(item.value));
    }};
}

function createControllerInput(): TaskDecisionInputSources<TestOutput> {
  const task = createTask();
  const agent = createAgent();
  const toolCatalog = createToolCatalogSnapshot([]);
  return {
    runId: "run_001",
    iteration: 1,
    agent,
    instructionBinding: createAgentInstructionBinding({
      run: { id: "run_001" },
      agent,
      effectiveFromRunRevision: 0,
      supersedes: null,
    }),
    task,
    inputItems: [],
    toolExposure: {
      schemaVersion: 1,
      id: "test-tool-exposure-1",
      selectionRevision: "test-tool-selection-1",
      contentRevision: "test-tool-exposure-content-1",
      basisRevision: "test-tool-exposure-basis-1",
      consumer: "controller",
      controllerRequestId: "run_001:controller:1",
      exposedTools: [],
      omittedToolCount: 0,
      omissionReasons: [],
      catalog: toolCatalog,
    },
    context: snapshotContextProjection({
      id: "projection-1",
      requestId: "projection-request-1",
      activeContext: Object.freeze({ id: "context-1", runId: "run_001", version: 1 }),
      estimator: Object.freeze({
        id: "utf8-bytes",
        revision: "1",
        unit: "bytes",
        accuracy: "exact",
      }),
      blocks: Object.freeze([]),
      accounting: Object.freeze({ unit: "bytes", amount: 0 }),
      manifestId: "manifest-1",
      createdAt: task.createdAt,
    }),
    contextManifest: Object.freeze({
      id: "manifest-1",
      projectionId: "projection-1",
      requestId: "projection-request-1",
      activeContext: Object.freeze({ id: "context-1", runId: "run_001", version: 1 }),
      profile: Object.freeze({ id: "test-controller-context", revision: "1" }),
      policy: Object.freeze({ id: "test-context-policy", revision: "1" }),
      estimator: Object.freeze({
        id: "utf8-bytes",
        revision: "1",
        unit: "bytes",
        accuracy: "exact",
      }),
      budget: Object.freeze({ unit: "bytes", maximum: 4 * 1_024 * 1_024 }),
      accounting: Object.freeze({
        unit: "bytes",
        consideredItems: 0,
        projectedItems: 0,
        projectedAmount: 0,
      }),
    }),
    interaction: Object.freeze({
      id: "run_001:model-interaction",
      revision: "0",
      messages: Object.freeze([]),
      unsettledCalls: Object.freeze([]),
      settledCallCount: 0,
      latestTurn: null,
    }),
    plan: null,
    planLimits: Object.freeze({
      maxSteps: 8,
      maxStepLength: 200,
      maxExplanationLength: 500,
    }),
    permission: testPermissionProjection(),
    pending: [],
    descendants: { active: [], continuations: [] },
    workspace: {
      id: "workspace_001",
      name: "Test workspace",
      rootRef: "workspace://root",
      trustState: "trusted",
      source: "test",
      policyRefs: [],
      metadata: {},
    },
    identity: {
      id: "user_001",
      kind: "user",
      displayName: "Test User",
      metadata: {},
    },
    metadata: {},
  };
}

function testPermissionProjection() {
  return {
    profile: {
      profileId: ":read-only",
      sourceProfileIds: [":read-only"],
      environmentId: "test",
      enforcement: "managed" as const,
      workspaceRootCount: 1,
      fileSystem: {
        unrestricted: false,
        allowsRead: true,
        allowsWrite: false,
        hasDenials: false,
        managed: false,
      },
      network: {
        enabled: false,
        profileRestricted: false,
        managedRestricted: false,
        hasDenials: false,
      },
      managedConstraintSetId: "test",
      canRequestAdditionalPermissions: false,
    },
    authority: {
      hasAdditionalFileSystemRead: false,
      hasAdditionalFileSystemWrite: false,
      hasAdditionalNetwork: false,
      actionCoverageCount: 0,
      runGrantCount: 0,
      sessionAuthorityCount: 0,
      policyAmendmentCount: 0,
    },
    approval: {
      canRequest: false,
      reviewer: null,
      pending: false,
      requestsRemaining: 0,
    },
  };
}

function createAgent(): AgentDefinition<TestOutput> {
  return {
    id: "agent_001",
    revision: "1",
    name: "Test Agent",
    instructions: testAgentInstructions("agent_001"),
    output: {
      validate(candidate) {
        if (
          typeof candidate === "object" &&
          candidate !== null &&
          "summary" in candidate &&
          typeof candidate.summary === "string"
        ) {
          return { valid: true, output: { summary: candidate.summary } };
        }

        return {
          valid: false,
          message: "Final output must contain a summary string.",
        };
      },
    },
    metadata: {},
  };
}

function testAgentInstructions(agentId: string) {
  return createAgentInstructions({
    id: `${agentId}.instructions`,
    release: { id: `${agentId}.release`, revision: "1" },
    model: { providerId: "test-provider", modelId: "test-model" },
    resolverRevision: "test-resolver.v1",
    blocks: [{
      id: "behavior",
      source: { owner: "test", kind: "instruction_source", id: `${agentId}.behavior`, revision: "1" },
      content: "Complete the test task.",
    }],
  });
}

function createTask(): AgentTask {
  return {
    id: "task_001",
    kind: "test.agent.run",
    input: {},
    createdAt: "2026-07-13T00:00:00.000Z",
    metadata: {},
  };
}

function request(content: string): TestProviderRequest {
  return {
    messages: [{ role: "user", content: [{ kind: "text", text: content }] }],
    purpose: "agent-control",
    correlation: {
      controllerRequestId: "run_001:controller:1",
      branchId: "run_001:main",
    },
    interaction: { kind: "structured_generation", outputFormat: TEST_OUTPUT_FORMAT },
    continuation: null,
    metadata: {},
  };
}

function ensureTestProviderContext(provider: Provider): Provider {
  if (provider.modelContext !== undefined) {
    return provider;
  }
  const context = createFakeProviderContext(
    provider.descriptor.id,
    "runtime-controller-test-model",
  );
  return {
    descriptor: {
      ...provider.descriptor,
      capabilities: {
        ...provider.descriptor.capabilities,
        modelContext: {
          capacity: context.modelContext.capacity,
          requestedOutput: context.modelContext.requestedOutput,
          inputPreservation: context.modelContext.inputPreservation,
        },
      },
    },
    modelContext: context.modelContext,
    requestBodyTransportLimit: context.requestBodyTransportLimit,
    send: provider.send.bind(provider),
  };
}

function accountTestRequest(
  request: TestProviderRequest,
  provider: Provider,
  input: TaskDecisionInputSources<TestOutput>,
  context: ProviderRequestBuildContext,
): ProviderRequest {
  const instructionSections = input.agent.instructions.blocks.map((block, index) => Object.freeze({
    id: `test:model-input:instruction:${index}`,
    source: Object.freeze({ ...block.source }),
    kind: "agent_instruction",
    role: "instruction" as const,
    necessity: "mandatory" as const,
    content: Object.freeze({ kind: "text" as const, text: block.content }),
  }));
  const requestSections = request.messages.map((message, index) => Object.freeze({
    id: `test:model-input:${index}`,
    source: Object.freeze({
      owner: "agent-runtime-test",
      kind: "provider_message",
      id: String(index),
      revision: "1",
    }),
    kind: "test_message",
    role: message.role,
    necessity: "mandatory" as const,
    content: Object.freeze({ kind: "model_message" as const, message }),
  }));
  const recoverySection = createModelOutputRecoverySection(context.outputRecovery);
  const sections = Object.freeze([...instructionSections, ...requestSections, ...createInputDeliverySections(input.inputDelivery),
    ...(recoverySection ? [recoverySection] : [])]);
  const composition = composeModelInput({
    id: `${input.runId}:test-model-input:${context.attemptNumber}`,
    providerId: context.target.providerId,
    model: context.target.model,
    interaction: request.interaction,
    sections,
    lineage: Object.freeze({
      instructionBinding: Object.freeze({
        owner: "agent-runtime",
        kind: "agent_instruction_binding",
        id: input.instructionBinding.ref.id,
        revision: input.instructionBinding.ref.revision,
      }),
      agent: Object.freeze({
        owner: "agent-core",
        kind: "agent_revision",
        id: input.agent.id,
        revision: input.agent.revision,
      }),
      instructions: Object.freeze({
        owner: "agent-core",
        kind: "agent_instructions",
        id: input.agent.instructions.ref.id,
        revision: input.agent.instructions.ref.revision,
      }),
      instructionRelease: Object.freeze({
        owner: "test",
        kind: "agent_instruction_release",
        id: input.agent.instructions.release.id,
        revision: input.agent.instructions.release.revision,
      }),
      instructionResolver: Object.freeze({
        owner: "test",
        kind: "agent_instruction_resolver",
        id: "test-resolver",
        revision: input.agent.instructions.resolverRevision,
      }),
      instructionContent: Object.freeze({
        owner: "agent-core",
        kind: "agent_instruction_content_digest",
        id: input.agent.instructions.ref.id,
        revision: `sha256:${input.agent.instructions.contentDigest.value}`,
      }),
      instructionModel: Object.freeze({
        providerId: context.target.providerId,
        model: context.target.model,
      }),
      instructionBlocks: Object.freeze(input.agent.instructions.blocks.map((block) =>
        Object.freeze({ ...block.source })
      )),
      activeContext: null,
      contextProjection: null,
      projectionManifest: null,
      toolSelection: Object.freeze({
        owner: "agent-core",
        kind: "tool_selection",
        id: input.toolExposure.selectionRevision,
        revision: input.toolExposure.selectionRevision,
      }),
      toolExposureContent: Object.freeze({
        owner: "agent-core",
        kind: "tool_exposure_content",
        id: input.toolExposure.contentRevision,
        revision: input.toolExposure.contentRevision,
      }),
      toolExposureBasis: Object.freeze({
        owner: "agent-core",
        kind: "tool_exposure_basis",
        id: input.toolExposure.basisRevision,
        revision: input.toolExposure.basisRevision,
      }),
      toolExposureProof: Object.freeze({
        owner: "agent-core",
        kind: "tool_exposure_proof",
        id: input.toolExposure.id,
        revision: input.toolExposure.id,
      }),
      toolGuidance: null,
      controllerControlGuidance: null,
      callableDefinitions: Object.freeze({
        owner: "agent-runtime-test",
        kind: "model_callable_definitions",
        id: "test-callable-definitions",
        revision: "1",
      }),
      modelQualification: null,
      interactionHistory: null,
      protocol: Object.freeze({
        owner: "agent-runtime-test",
        kind: "controller_contract",
        id: "test-controller-output-v1",
        revision: "1",
      }),
      policy: Object.freeze({
        owner: "agent-runtime-test",
        kind: "request_policy",
        id: "test-request-policy",
        revision: "1",
      }),
    }),
    composedAt: input.task.createdAt,
  });
  const modelInput = modelInputFromComposition(composition);
  return Object.freeze({
    ...request,
    requestId: composition.id,
    instructions: modelInput.instructions,
    messages: modelInput.messages,
    composition,
    modelContext: Object.freeze({
      requestedOutput: context.requestedOutput,
      headroom: Object.freeze({
        unit: "tokens" as const,
        amount: 0,
        policy: Object.freeze({ id: "runtime-controller-test", revision: "1" }),
      }),
      assessment: null,
    }),
  });
}

function succeededResult(output: unknown): ProviderCallResult {
  return {
    kind: "succeeded",
    response: {
      kind: "structured_generation",
      output: output as never,
      responseId: null,
      continuation: null,
      usage: null,
      metadata: {},
    },
  };
}

function continuationSucceededResult(
  output: unknown,
  responseId: string,
  handle: string,
): ProviderCallResult {
  return {
    kind: "succeeded",
    response: {
      kind: "structured_generation",
      output: output as never,
      responseId,
      continuation: {
        kind: "opaque_provider_state",
        handle,
        sensitivity: "restricted",
      },
      usage: null,
      metadata: {},
    },
  };
}

function failedResult(
  category: string,
  code: string,
  metadata: Record<string, unknown> = {},
): ProviderCallResult {
  const { retryAfterMs, requestId, statusCode, ...safeMetadata } = metadata;
  return {
    kind: "failed",
    failure: {
      category,
      code,
      message: "Provider request failed.",
      ...(typeof retryAfterMs === "number" ? { retryAfterMs } : {}),
      ...(typeof requestId === "string" ? { requestId } : {}),
      ...(typeof statusCode === "number" ? { statusCode } : {}),
      metadata: safeMetadata,
    },
  };
}

function correctionError(
  category: ConstructorParameters<typeof StructuredOutputError>[0]["category"],
  code: string,
  correctionFeedback: string,
): StructuredOutputError {
  return new StructuredOutputError({ category, code, correctionFeedback });
}

function finalDecision(output: unknown): TaskDecisionProposal<TestOutput> {
  return { candidates: [], completionSource: {kind: "controller" as const},
    kind: "propose_completion",
    output: output as TestOutput,
    modelItems: modelItems("model_item_1", output),
  };
}

function modelItems(id: string, content: unknown) {
  return createControllerModelItems({
    turnId: id,
    assistant: {
      role: "assistant",
      content: [{
        kind: "text",
        text: typeof content === "string" ? content : JSON.stringify(content),
      }],
    },
    finish: { kind: "normal" },
    usage: null,
    responseRef: {
      providerId: "fake-provider",
      requestId: "request-1",
      responseId: id,
    },
  });
}

function modelCall(id: string, name: string, ordinal: number): ModelCallableRequest {
  const turnId = "model-call-turn";
  return Object.freeze({
    modelCallRef: Object.freeze({
      id,
      providerRequestId: "request-1",
      controllerRequestId: "run_001:controller:1",
      turnId,
      contentBlockOrdinal: ordinal,
      branchId: "run_001:main",
    }),
    providerCallRef: null,
    name,
    input: Object.freeze({}),
    ordinal,
  });
}

function modelCallItems(calls: readonly ModelCallableRequest[]) {
  return createControllerModelItems({
    turnId: "model-call-turn",
    assistant: {
      role: "assistant",
      content: calls.map((call) => Object.freeze({
        kind: "model_tool_call" as const,
        call,
      })),
    },
    finish: { kind: "normal" },
    usage: null,
    responseRef: {
      providerId: "fake-provider",
      requestId: "request-1",
      responseId: "model-call-response",
    },
  });
}

function duplicateModelItems() {
  const item = modelItems("duplicate", {})[0]!;
  return [item, item];
}

function callContext(
  cancellation = createRunCancellationController({ runId: "run_001" }).context,
  overrides: Partial<{
    maxRetries: number;
    retryableCategories: string[];
    baseDelayMs: number;
    maxDelayMs: number;
    serverDelay:
      | { mode: "ignore" }
      | { mode: "prefer_trusted"; maxServerDelayMs: number };
    deadlineAt: string;
    events: Array<Record<string, unknown>>;
    structuredMaxRetries: number;
    structuredRetryableCategories: string[];
    structuredBaseDelayMs: number;
    structuredMaxDelayMs: number;
  }> = {},
): AgentActivityExecutionContext {
  const providerPolicy = {
    maxRetries: overrides.maxRetries ?? 0,
    delay: {
      kind: "exponential_jitter" as const,
      baseDelayMs: overrides.baseDelayMs ?? 0,
      maxDelayMs: overrides.maxDelayMs ?? 0,
      multiplier: 2 as const,
      jitterRatio: 0.1 as const,
    },
    retryableCategories: overrides.retryableCategories ?? [],
    serverDelay: overrides.serverDelay ?? { mode: "ignore" as const },
  };
  const structuredOutputPolicy = {
    maxRetries: overrides.structuredMaxRetries ?? 0,
    delay: {
      kind: "exponential_jitter" as const,
      baseDelayMs: overrides.structuredBaseDelayMs ?? 0,
      maxDelayMs: overrides.structuredMaxDelayMs ?? 0,
      multiplier: 2 as const,
      jitterRatio: 0.1 as const,
    },
    retryableCategories: overrides.structuredRetryableCategories ?? [],
    serverDelay: { mode: "ignore" as const },
  };
  return {
    cancellation,
    retry: {
      providerRequest: providerPolicy,
      structuredOutput: structuredOutputPolicy,
      deadlineAt: overrides.deadlineAt ?? "2099-01-01T00:00:00.000Z",
      events: {
        emit(event) {
          overrides.events?.push(event as unknown as Record<string, unknown>);
        },
      },
    },
  };
}

async function waitForRetryEvent(
  events: readonly Record<string, unknown>[],
  type: string,
): Promise<void> {
  await vi.waitFor(() => expect(events.some(event => event.type === type)).toBe(true));
}

function throwingProvider(): Provider {
  return {
    descriptor: providerDescriptor("throwing-provider"),
    async send() {
      throw new Error("secret upstream details");
    },
  };
}

function providerDescriptor(id: string) {
  const context = createFakeProviderContext(id, "runtime-controller-test-model");
  return {
    id,
    name: id,
    capabilities: {
      nativeToolInteraction: { supported: false as const },
      structuredGeneration: { supported: true as const },
      streaming: { supported: false as const },
      modelContext: {
        capacity: context.modelContext.capacity,
        requestedOutput: context.modelContext.requestedOutput,
        inputPreservation: context.modelContext.inputPreservation,
      },
      continuation: { supported: false as const },
      compaction: { supported: false as const },
      usageMetering: {
        inputTokens: "unavailable" as const,
        outputTokens: "unavailable" as const,
        costUnits: "unavailable" as const,
      },
    },
    requestRetryScheduler: { kind: "harness" as const },
    metadata: {},
  };
}

function continuationProviderDescriptor() {
  const descriptor = providerDescriptor("continuation-provider");
  return {
    ...descriptor,
    capabilities: {
      ...descriptor.capabilities,
      continuation: {
        supported: true as const,
        mechanism: "response_chaining" as const,
        supportsCompaction: false,
      },
    },
  };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("Expected promise to reject.");
}
