import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { InspectionRecorder } from "../../dist/recording/InspectionRecorder.js";
import { InspectionQueryService } from "../../dist/query/InspectionQueryService.js";
import { DEFAULT_INSPECTION_CAPTURE_POLICY } from "../content/index.js";
import { snapshotInspectionJson } from "../records/InspectionValidation.js";
import { retireInspectionDatasets } from "../../dist/storage/index.js";
import { datasetDirectory } from "../sources/index.js";
import { acquireInspectionReadLease } from "../storage/InspectionDatasetAccess.js";
import { RunExecutionInspectionAdapter, RunTranscriptInspectionAdapter, ProviderInspectionAdapter } from "../../dist/adapters/index.js";
import { retainInputPresentation, createModelConversationSeed, importModelConversationSeed } from "@agent-anything/agent-runtime/controller";
import { modelInputFromSections, createExactModelWorkingView, createOwnerModelWorkingView, applyModelInputOwnerForms,
  modelInputOccurrenceDigest, type ModelInputOwnerForm, type ModelInputSectionCandidate } from "@agent-anything/model-interaction/input";
import { createModelNativeInputFootprint, planModelInput, observeModelInputUsage } from "@agent-anything/model-interaction/context";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function setup(rich = false) {
  const directory = mkdtempSync(join(tmpdir(), "agent-inspection-test-"));
  cleanup.push(async () => { const target = resolve(directory); if (!relative(tmpdir(), target).startsWith("agent-inspection-test-")) throw new Error("Invalid cleanup target"); rmSync(target, { recursive: true, force: true }); });
  const recorder = await InspectionRecorder.create({ root: directory, application: "test", name: "Test", policy: { ...DEFAULT_INSPECTION_CAPTURE_POLICY, agent: rich } });
  const query = new InspectionQueryService(directory);
  cleanup.push(async () => query.close()); cleanup.push(async () => recorder.flush(true));
  const subject = recorder.ref("runtime", "run", "run-1", "run-1");
  return { directory, recorder, query, subject, selection: { sourceId: subject.sourceId, datasetId: subject.datasetId } };
}
describe("Inspection recording", () => {
  it("links input planning to exact requests and prior accepted usage without promoting cache counters to capacity", async () => {
    const {recorder, query, selection} = await setup(true);
    recorder.setPolicy({...DEFAULT_INSPECTION_CAPTURE_POLICY, revision: "provider-content", agent: true, provider: true});
    const provider = new ProviderInspectionAdapter(recorder);
    const at = "2026-10-23T00:00:00Z";
    const section: ModelInputSectionCandidate = {id: "assignment", kind: "task", role: "user", necessity: "mandatory",
      source: {owner: "agent-core", kind: "task", id: "task", revision: "1"}, content: {kind: "text", text: "Inspect."}};
    const footprint = createModelNativeInputFootprint({messages: [{role: "user", content: "Inspect."}]});
    const accounting = {basis: {endpoint: "fixture"}, inputUsage: "complete" as const, outputUsage: "complete" as const,
      defaultGenerationRoom: null, limitations: ["input_preservation_unqualified"], project: () => footprint};
    const plan = (requestId: string, previous: ReturnType<typeof observeModelInputUsage>) => planModelInput({requestId,
      runId: "run-1", purpose: "controller", accounting, footprint, previous, capacity: {supported: false}, growthPolicy: "exact",
      measurement: {status: "unknown", unit: "tokens", accuracy: "unknown", estimator: null, reason: "unsupported",
        measuredCompositionId: requestId, measuredAt: at}});
    const usage = {inputTokens: 100, outputTokens: 10, totalTokens: 110, costUnits: null, metadata: {cachedInputTokens: 80}};
    const planning = plan("request-2", observeModelInputUsage(plan("request-1", null), usage, "response-1", true));
    const exchange = {attemptId: "attempt-2", requestId: "request-2", runId: "run-1", controllerRequestId: null,
      providerId: "fixture", model: "model", occurredAt: at, endpoint: "http://localhost/chat", httpStatus: 200,
      encodedBytes: 100, code: null, status: "succeeded", body: null, contentUnavailable: false};
    provider.observe({...exchange, stage: "request", request: {requestId: "request-2", purpose: "controller",
      ...modelInputFromSections([section]), composition: {id: "request-2", sections: [section], lineage: {},
        workingView: createExactModelWorkingView({sections: [section], recipientRunId: "run-1", boundary: "request"})},
      interaction: {kind: "native_tool_turn", callables: []}, modelContext: {assessment: {planning, disposition: "unresolved", measurement: planning.measurement}}}} as never);
    provider.observe({...exchange, stage: "settled", result: {kind: "succeeded", response: {kind: "native_tool_turn",
      turn: {turnId: "turn-2", usage, finish: {kind: "normal"}, assistant: {content: []}}}}} as never);
    await recorder.flush();
    const scope = (await query.query({...selection, kind: "get_snapshot"})).selection!;
    const records = (await query.query({...scope, kind: "list_records", limit: 100})).records;
    const recorded = records.find(record => record.payload.kind === "context_planning");
    expect(recorded?.payload).toMatchObject({measurement: "estimated", inputTokens: 100, anchorRequestId: "request-1"});
    expect(recorded?.links).toEqual(expect.arrayContaining([
      expect.objectContaining({kind: "binding", to: expect.objectContaining({id: "request-2"}), targetLocation: expect.objectContaining({jsonPointer: "/modelContext/assessment/planning"})}),
      expect.objectContaining({operation: "accepted_usage_anchor", to: expect.objectContaining({id: "request-1"})}),
    ]));
    expect(records.find(record => record.payload.kind === "event" && record.payload.name === "provider.usage_observed")?.contents[0]?.availability).toBe("present");
    expect(recorder.health()).toMatchObject({rejected: 0, dropped: 0});
  });
  it("pages exact request deliveries and distinguishes inclusion, acceptance, replay and scoped Child import", async () => {
    const {recorder, query, selection} = await setup(true);
    const provider = new ProviderInspectionAdapter(recorder), transcript = new RunTranscriptInspectionAdapter(recorder);
    const now = "2026-10-21T00:00:00Z";
    const section = (run: string, index: number): ModelInputSectionCandidate => ({id: `${run}:opening:${index}`,
      kind: "conversation_opening", role: "user", necessity: "mandatory", content: {kind: "text", text: `Material ${index}`},
      source: {owner: "context", kind: "context_contribution", id: `material-${index}`, revision: "1", runId: run},
      provenance: {purpose: index === 0 ? "assignment" : "selected_material", author: "parent", recipientRunId: run,
        sources: [{owner: "context", kind: "context_contribution", id: `material-${index}`, revision: "1", runId: run}],
        presenter: {owner: "test", kind: "presenter", id: "opening", revision: "1"}, coverage: [`material-${index}`], limitations: []}});
    const offer = (runId: string, requestId: string, sections: readonly ModelInputSectionCandidate[]) => provider.observe({
      stage: "request", runId, requestId, attemptId: `${requestId}:attempt`, providerId: "fixture", model: "fixture", occurredAt: now,
      request: {requestId, purpose: "controller", ...modelInputFromSections(sections), composition: {id: requestId, sections, lineage: {},
        workingView: createExactModelWorkingView({sections, recipientRunId: runId, boundary: "request"})},
        interaction: {kind: "native_tool_turn", callables: []}},
    } as never);
    const original = retainInputPresentation(section("child-old", 0));
    offer("child-old", "first-request", [original.section]);
    transcript.observe({runId: "child-old", item: {ref: {id: "accepted-item", sequence: 1}, createdAt: now,
      payload: {kind: "controller_turn", turn: {id: "accepted-turn"}, modelItems: [], toolExposure: {exposedTools: []},
        openingReceipt: {requestId: "first-request", presentations: [original], workingViewId:
          createExactModelWorkingView({sections: [original.section], recipientRunId: "child-old", boundary: "request"}).id}}}} as never);
    offer("child-old", "replayed-request", [{...original.section, kind: "conversation_opening_history",
      provenance: {...original.section.provenance!, retainedPresentation: {owner: "agent-runtime", kind: "presentation",
        id: original.section.id, revision: original.digest, runId: "child-old"}}}]);
    const seed = createModelConversationSeed("child-old", "5", [original]);
    const imported = importModelConversationSeed(seed, "child-new");
    offer("child-new", "continued-request", [...imported.map(value => value.section), ...Array.from({length: 70}, (_, index) => section("child-new", index))]);
    await recorder.flush();
    const scope = (await query.query({...selection, kind: "get_snapshot"})).selection!;
    const request = recorder.ref("model-interaction", "request", "continued-request", "child-new");
    const page = await query.query({...scope, kind: "get_conversation_delivery", subject: request, limit: 50});
    const rest = await query.query({...scope, kind: "get_conversation_delivery", subject: request, limit: 50, after: String(page.next)});
    const entries = [...page.records, ...rest.records];
    expect(entries).toHaveLength(71);
    expect(entries.map(record => record.payload.kind === "conversation" ? record.payload.position : null)).toEqual(Array.from({length: 71}, (_, index) => index));
    expect(entries[0]?.payload).toMatchObject({delivery: "import", originRunId: "child-old", recipientRunId: "child-new", attemptId: "continued-request:attempt"});
    expect(entries[0]?.links).toContainEqual(expect.objectContaining({kind: "transforms", operation: "scoped_history_import",
      from: expect.objectContaining({runId: "child-old", revision: original.digest}), to: expect.objectContaining({runId: "child-new"})}));
    expect(entries[0]?.links).toContainEqual(expect.objectContaining({kind: "includes", targetLocation: expect.objectContaining({jsonPointer: "/messages/0/content/0", stage: "semantic"})}));
    const oldRequest = recorder.ref("model-interaction", "request", "first-request", "child-old");
    const first = await query.query({...scope, kind: "get_conversation_delivery", subject: oldRequest});
    expect(first.records).toHaveLength(1);
    expect(first.records[0]?.payload).toMatchObject({stage: "included", delivery: "new", requestId: "first-request"});
    await expect(query.query({...scope, kind: "get_conversation_delivery", subject: oldRequest, after: String(page.next)})).rejects.toThrow("inspection_cursor_invalid");
    const graph = (await query.query({...scope, kind: "get_data_flow", subject: entries[0]!.subject})).graph!;
    expect(graph.links.some(link => link.operation === "scoped_history_import")).toBe(true);
    expect(recorder.health().rejected).toBe(0);
  });
  it("keeps notification preparation and accepted history separate from request inclusion", async () => {
    const {recorder, query, selection} = await setup(true);
    const execution = new RunExecutionInspectionAdapter(recorder);
    const transcript = new RunTranscriptInspectionAdapter(recorder);
    const now = "2026-10-13T00:00:00.000Z";
    const notification = {runId: "run-1", sequence: 1, occurredAt: now,
      source: {owner: "process", kind: "scope_closed", id: "process-1", revision: "7"}, data: {exitCode: 0}};
    const batch = {id: "batch-1", revision: "1", runId: "run-1", entries: [notification]};
    execution.observe({kind: "input_delivery_prepared", runId: "run-1", occurredAt: now, turnId: "turn-1", batch});
    transcript.observe({runId: "run-1", sequence: 1, item: {ref: {id: "delivery-1", sequence: 1}, createdAt: now,
      payload: {kind: "input_delivery", batch, turn: {id: "turn-1"}, receipt: {via: {kind: "provider", requestId: "request-1", workingViewId: "view-1", presentations: []}}}}} as never);
    transcript.observe({runId: "run-1", sequence: 2, item: {ref: {id: "closure-1", sequence: 2}, createdAt: now,
      payload: {kind: "input_delivery_closed", reason: "cancelled", entries: [{...notification, sequence: 2}]}}} as never);
    await recorder.flush();
    const snapshot = (await query.query({kind: "get_snapshot", ...selection})).selection!;
    const recorded = await query.query({kind: "list_records", ...snapshot, limit: 100});
    expect(recorded.records.map(record => record.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({name: "input_delivery.prepared"}), expect.objectContaining({name: "input_delivery.accepted"}),
    ]));
    const flow = (await query.query({kind: "get_data_flow", ...snapshot})).graph!;
    expect(flow.links).toEqual(expect.arrayContaining([
      expect.objectContaining({kind: "includes", from: expect.objectContaining({id: "process-1", revision: "7"}), to: expect.objectContaining({id: "batch-1"})}),
      expect.objectContaining({kind: "delivers", from: expect.objectContaining({id: "batch-1"}), to: expect.objectContaining({id: "turn-1"})}),
      expect.objectContaining({kind: "includes", from: expect.objectContaining({id: "batch-1"}), to: expect.objectContaining({id: "request-1"})}),
    ]));
    expect(recorder.health().rejected).toBe(0);
  });

  it("links Plan commits and no-change outcomes to exact versions and Context sources", async () => {
    const { recorder, query, selection } = await setup(true);
    const transcript = new RunTranscriptInspectionAdapter(recorder);
    const execution = new RunExecutionInspectionAdapter(recorder);
    const now = "2026-10-13T00:00:00.000Z";
    const plan = { id: "plan-1", version: 2, status: "active", steps: [
      { step: "A", status: "in_progress" }, { step: "B", status: "in_progress" },
    ] };
    transcript.observe({ runId: "run-1", sequence: 1, item: { ref: { id: "commit", sequence: 1 }, createdAt: now,
      payload: { kind: "state_transition", transition: "plan", previousRevision: 1, plan } } } as never);
    for (const [index, status] of ["applied", "no_change", "rejected"].entries()) {
      transcript.observe({ runId: "run-1", sequence: index + 2, item: { ref: { id: `item-${status}`, sequence: index + 2 }, createdAt: now,
        payload: { kind: "observation", observation: { id: `outcome-${status}`, runId: "run-1", owner: "runtime", createdAt: now,
          runAction: { id: `action-${status}` }, lowerRefs: [], payload: { kind: "plan_update", result: status === "rejected"
            ? { status, code: "plan_invalid", message: "Invalid step" }
            : { status, planId: "plan-1", version: 2 } } } } } } as never);
    }
    execution.observe({ kind: "context_source", runId: "run-1", occurredAt: now,
      source: { owner: "agent-runtime", kind: "run_plan", id: "run-1", revision: "9", observedAt: now },
      value: plan, inputs: [{ owner: "runtime", kind: "plan", id: "plan-1", revision: "2" }] });
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    const flow = (await query.query({ kind: "get_data_flow", ...snapshot })).graph!;
    expect(flow.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "produces", from: expect.objectContaining({ id: "outcome-applied" }), to: expect.objectContaining({ id: "plan-1", revision: "2" }) }),
      expect.objectContaining({ kind: "includes", from: expect.objectContaining({ id: "plan-1", revision: "2" }), to: expect.objectContaining({ id: "run_plan:run-1", revision: "9" }) }),
    ]));
    expect(flow.links.some(link => link.from.id === "outcome-rejected" && link.to.id === "plan-1")).toBe(false);
    const unchanged = await query.query({ kind: "get_subject", ...snapshot, subject: recorder.ref("runtime", "contribution", "outcome-no_change", "run-1", "1") });
    expect(unchanged.records.flatMap(record => record.links)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "binding", from: expect.objectContaining({ id: "outcome-no_change" }), to: expect.objectContaining({ id: "plan-1", revision: "2" }) }),
    ]));
    const recorded = await query.query({ kind: "get_subject", ...snapshot, subject: recorder.ref("runtime", "contribution", "plan-1", "run-1", "2") });
    const commit = recorded.records.find(record => record.payload.kind === "event" && record.payload.name === "plan.committed")!;
    expect(commit).toBeDefined();
    const body = await query.query({ kind: "get_content", ...snapshot, contentId: commit.contents[0]!.id });
    expect(JSON.parse(body.content!.text!).steps).toEqual(plan.steps);
    expect(recorder.health().rejected).toBe(0);
  });

  it("reports unsupported Source format without migrating or replacing retained metadata", async () => {
    const { directory, recorder, selection } = await setup();
    await recorder.flush(true);
    const path = join(directory, "sources", selection.sourceId, "source.json");
    const metadata = JSON.parse(readFileSync(path, "utf8"));
    const text = JSON.stringify({ ...metadata, formatVersion: 0 });
    writeFileSync(path, text);
    await expect(InspectionRecorder.create({ root: directory, application: "test", name: "Test" })).rejects.toMatchObject({ code: "inspection_source_unsupported" });
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("writes and heartbeats without traversing historical Source entries", async () => {
    const { directory, recorder, query, selection, subject } = await setup();
    const outside = join(directory, "outside"); mkdirSync(outside);
    const link = join(directory, "sources", selection.sourceId, "unrelated-history-link");
    symlinkSync(outside, link, "junction");
    try {
      await new Promise(resolve => setTimeout(resolve, 5200));
      expect(recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "after-heartbeat", sequence: null, code: null } })).toBe(true);
      await recorder.flush();
      expect(recorder.health()).toMatchObject({ available: true, queued: 0, dropped: 0, rejected: 0, code: null });
      const snapshot = await query.query({ kind: "get_snapshot", ...selection });
      expect(snapshot.coverage?.captured).toBeGreaterThan(0);
    } finally { rmdirSync(link); }
  }, 15000);

  it.each([0, 1])("records Model Turn provenance with %i calls and keeps logical Retry Attempts distinct from HTTP Attempts", async (callCount) => {
    const {recorder, query, selection} = await setup(true);
    const execution = new RunExecutionInspectionAdapter(recorder);
    const provider = new ProviderInspectionAdapter(recorder);
    const now = "2026-09-14T00:00:00Z";
    const call = {id: "call-id", turnId: "model-turn", providerRequestId: "provider-request", controllerRequestId: "controller-request", contentBlockOrdinal: 0};
    execution.observe({kind: "tool_exposure", runId: "run-1", occurredAt: now, turnId: "controller-turn", selected: [], exposure: {exposedTools: [], omissions: []}, proof: {controllerRequestId: call.controllerRequestId}} as never);
    const exchange = {attemptId: "http-attempt", requestId: call.providerRequestId, runId: "run-1", controllerRequestId: call.controllerRequestId, providerId: "test", model: "test", occurredAt: now, endpoint: "http://localhost/api/chat", httpStatus: 200, encodedBytes: 100, code: null, status: "succeeded", result: null, body: null, contentUnavailable: false};
    const section: ModelInputSectionCandidate = {id: "task-section", kind: "task", role: "user", necessity: "mandatory", source: {owner: "agent-core", kind: "task", id: "task", revision: "1"}, content: {kind: "text", text: "Inspect the workspace."}};
    provider.observe({...exchange, stage: "request", request: {requestId: call.providerRequestId, purpose: "controller", ...modelInputFromSections([section]),
      composition: {id: "composition", sections: [section], lineage: {}, workingView: createExactModelWorkingView({sections: [section], recipientRunId: "run-1", boundary: "request"})},
      interaction: {kind: "native_tool_turn", callables: []}}} as never);
    provider.observe({...exchange, stage: "settled", result: {kind: "succeeded", response: {kind: "native_tool_turn", turn: {turnId: "model-turn", usage: null, finish: {kind: "normal"}, assistant: {content: callCount ? [{kind: "model_tool_call", call: {modelCallRef: call}}] : [{kind: "text", text: "Done"}]}}}}} as never);
    if (callCount) execution.observe({kind: "scheduling", runId: "run-1", occurredAt: now, call, position: 0, disposition: "queued", rule: "decision_source_order", groupId: null, reason: null} as never);
    execution.observe({kind: "retry_event", runId: "run-1", occurredAt: now, event: {type: "retry_attempt_started", runId: "run-1", owner: "provider_request", operationId: "retry-operation", attemptId: "logical-attempt", occurredAt: now}} as never);
    await recorder.flush();
    const scope = (await query.query({kind: "get_snapshot", ...selection})).selection!;
    const records = (await query.query({...scope, kind: "list_records", limit: 100})).records;
    const modelTurn = records.filter(record => record.subject.id === "model-turn");
    expect(modelTurn.flatMap(record => record.links)).toEqual(expect.arrayContaining([
      expect.objectContaining({kind: "materializes", from: expect.objectContaining({id: "controller-request"}), to: expect.objectContaining({id: "model-turn"})}),
      expect.objectContaining({kind: "produces", from: expect.objectContaining({id: "provider-request"}), to: expect.objectContaining({id: "model-turn"})}),
    ]));
    expect(records.filter(record => record.subject.kind === "provider-attempt").map(record => record.subject.id)).toEqual(["http-attempt", "http-attempt"]);
    expect(records.find(record => record.subject.id === "logical-attempt")?.subject).toMatchObject({owner: "retry", kind: "attempt"});
    expect(records.find(record => record.subject.id === "retry-operation")?.subject).toMatchObject({owner: "retry", kind: "operation"});
    expect(records.find(record => record.subject.id === "controller-request")).toBeDefined();
    expect(recorder.health().rejected).toBe(0);
  });
  it("keeps revision-bound Run state, plan and feedback source identities and bodies separate", async () => {
    const {recorder, query, selection} = await setup(true);
    const adapter = new RunExecutionInspectionAdapter(recorder);
    const now = "2026-09-14T00:00:00Z";
    for (const revision of ["1", "2"]) {
      const sources = ["run_state", "run_plan", "controller_feedback"].map(kind => ({owner: kind === "controller_feedback" ? "agent-hooks" : "agent-runtime", kind, id: "same-id", revision, observedAt: now}));
      for (const source of sources) adapter.observe({kind: "context_source", runId: "run-1", occurredAt: now, source, value: {kind: source.kind, revision}});
      adapter.observe({kind: "context_committed", runId: "run-1", occurredAt: now, context: {ref: {id: "context", version: Number(revision)}, items: sources.map(source => ({lifecycle: {kind: "active"}, contribution: {ref: {id: source.kind, revision}, source}}))}} as never);
    }
    await recorder.flush();
    const scope = (await query.query({...selection, kind: "get_snapshot"})).selection!;
    const records = (await query.query({...scope, kind: "list_records", limit: 100})).records;
    const sourceRecords = records.filter(record => record.payload.kind === "event" && record.payload.name.startsWith("context.source."));
    expect(sourceRecords).toHaveLength(6);
    expect(new Set(sourceRecords.map(record => JSON.stringify(record.subject))).size).toBe(6);
    for (const record of sourceRecords) {
      expect(record.contents[0]?.availability).toBe("present");
      expect(records.flatMap(item => item.links).some(link => link.kind === "produces" && JSON.stringify(link.from) === JSON.stringify(record.subject))).toBe(true);
    }
    expect(recorder.health().rejected).toBe(0);
  });
  it("links owner input notifications through Run admission and prepared delivery", async () => {
    const {recorder, query, selection} = await setup(true);
    const adapter = new RunExecutionInspectionAdapter(recorder);
    const transcript = new RunTranscriptInspectionAdapter(recorder);
    const now = "2026-10-03T00:00:00Z";
    const source = {owner: "command", kind: "command_completed", id: "process-1", revision: "4", observedAt: now};
    const notification = {runId: "run-1", sequence: 1, source, occurredAt: now, data: {exitCode: 1}};
    const batch = {id: "turn-1:input-delivery", revision: "1-1", runId: "run-1", entries: [notification]};
    adapter.observe({kind: "context_source", runId: "run-1", occurredAt: now, source, value: notification});
    transcript.observe({runId: "run-1", sequence: 1, item: {ref: {id: "notification-item", sequence: 1}, createdAt: now,
      payload: {kind: "input_notification", notification}}} as never);
    adapter.observe({kind: "input_delivery_prepared", runId: "run-1", occurredAt: now, turnId: "turn-1", batch});
    await recorder.flush();
    const scope = (await query.query({...selection, kind: "get_snapshot"})).selection!;
    const graph = (await query.query({...scope, kind: "get_data_flow", subject: recorder.ref(source.owner, "contribution", source.id, "run-1", source.revision)})).graph!;
    expect(graph.links).toEqual(expect.arrayContaining([
      expect.objectContaining({kind: "delivers", from: expect.objectContaining({id: source.id, revision: "4"}), to: expect.objectContaining({id: "notification-item"})}),
      expect.objectContaining({kind: "includes", from: expect.objectContaining({id: source.id, revision: "4"}), to: expect.objectContaining({id: batch.id, revision: "1-1"})}),
    ]));
    expect(recorder.health().rejected).toBe(0);
  });

  it("links a committed feedback occurrence to its Call result without a duplicate Context source", async () => {
    const {recorder, query, selection} = await setup(true);
    const transcript = new RunTranscriptInspectionAdapter(recorder);
    const now = "2026-10-20T00:00:00Z";
    const turn = {id: "turn-1", run: {id: "run-1"}, sequence: 1};
    const feedback = {source: {owner: "agent-hooks", kind: "stop", id: "handler-1", revision: "1"},
      code: "continue", message: "Consider the outstanding results."};
    transcript.observe({runId: "run-1", sequence: 1, item: {ref: {id: "feedback-item", sequence: 1}, createdAt: now,
      payload: {kind: "controller_feedback", feedback, turn}}} as never);
    transcript.observe({runId: "run-1", sequence: 2, item: {ref: {id: "settlement-item", sequence: 2}, createdAt: now,
      payload: {kind: "model_call_settlement", result: {
        modelCallRef: {id: "call-1", contentBlockOrdinal: 0}, content: feedback, name: "final_result", settlement: "invalidated",
        presentation: {disposition: "complete", failureCode: null, presenter: {id: "runtime", revision: "1"}},
        sourceRefs: [{owner: "agent-runtime", kind: "controller_feedback", id: "turn-1:feedback", revision: "1"}],
      }}}} as never);
    await recorder.flush();
    const scope = (await query.query({...selection, kind: "get_snapshot"})).selection!;
    const graph = (await query.query({...scope, kind: "get_data_flow"})).graph!;
    expect(graph.links).toContainEqual(expect.objectContaining({kind: "delivers", operation: "call_feedback_delivery",
      from: expect.objectContaining({id: "turn-1:feedback", revision: "1"}),
      to: expect.objectContaining({id: "call-1:presentation"})}));
    const records = (await query.query({...scope, kind: "list_records", limit: 100})).records;
    expect(records.filter(record => record.payload.kind === "event" && record.payload.name === "controller_feedback.committed")).toHaveLength(1);
    expect(recorder.health().rejected).toBe(0);
  });

  it.each([false, true])("links a replayed result to its actual request location without relabeling its source Run (owner form=%s)", async ownerForm => {
    const {recorder, query, selection} = await setup(true);
    const provider = new ProviderInspectionAdapter(recorder);
    const result = {modelCallRef: {id: "call-1", turnId: "source-turn", providerRequestId: "source-request",
      controllerRequestId: "source-controller", contentBlockOrdinal: 0, branchId: "opaque-branch"}, providerCallRef: null,
      name: "Read", settlement: "succeeded", presentation: {presenter: {id: "fixture", revision: "1"},
        disposition: "complete", failureCode: null}, sourceRefs: [
      {owner: "agent-runtime", kind: "model_call", id: "call-1", revision: null, runId: "source-run"}],
      content: {text: "retained"}} as const;
    const sections: ModelInputSectionCandidate[] = [
      {id: "original-call", kind: "interaction_history", role: "assistant", necessity: "mandatory",
        source: {owner: "fixture", kind: "turn", id: "source-turn", revision: "1", runId: "source-run"},
        content: {kind: "model_message", message: {role: "assistant", content: [{kind: "model_tool_call", call: {
          modelCallRef: result.modelCallRef, providerCallRef: null, name: "Read", ordinal: 0, input: {path: "file"}}}]}}},
      {id: "history", kind: "interaction_history", role: "tool", necessity: "mandatory",
        source: {owner: "fixture", kind: "result", id: "history", revision: "1", runId: "source-run"},
        content: {kind: "model_message", message: {role: "tool", content: [{kind: "model_tool_result", result}]}}},
    ];
    const forms: ModelInputOwnerForm[] = [];
    if (ownerForm) {
      sections[1] = {...sections[1]!, preservation: {obligations: [{id: "result", requirement: "account", basis: "Owner-approved result account"}], relationships: []}};
      sections.push({id: "next-turn", kind: "interaction_history", role: "assistant", necessity: "mandatory",
        source: {owner: "fixture", kind: "turn", id: "next-turn", revision: "1", runId: "source-run"}, content: {kind: "text", text: "Finding accepted"}});
      forms.push({id: "owner-result", sectionId: "history", sourceDigest: modelInputOccurrenceDigest(sections[1]!),
        owner: {owner: "fixture", kind: "presenter", id: "result-account", revision: "1"}, method: "owner_presentation",
        content: {kind: "model_message", message: {role: "tool", content: [{kind: "model_tool_result", result: {...result, content: {text: "Account"}}}]}},
        satisfies: ["result"], companions: ["original-call"], dependencies: [], limitations: ["Not the original result body"]});
    }
    const actual = applyModelInputOwnerForms(sections, forms, "consumer-run");
    const workingView = createOwnerModelWorkingView({sections: actual, recipientRunId: "consumer-run", boundary: "request", forms});
    provider.observe({stage: "request", runId: "consumer-run", requestId: "request-replay", attemptId: "attempt-replay",
      occurredAt: "2026-10-13T00:00:00Z", providerId: "fixture", model: "fixture", controllerRequestId: null,
      request: {requestId: "request-replay", purpose: "controller", composition: {id: "composition", sections: actual, lineage: {}, workingView},
        ...modelInputFromSections(actual), interaction: {kind: "text_generation"}}} as never);
    await recorder.flush();
    const scope = (await query.query({...selection, kind: "get_snapshot"})).selection!;
    const graph = (await query.query({...scope, kind: "get_data_flow"})).graph!;
    expect(graph.links).toContainEqual(expect.objectContaining({kind: "includes", operation: ownerForm ? "owner_form_result_history" : "model_result_history",
      from: expect.objectContaining(ownerForm ? {id: `${workingView.id}:selection:1`, runId: "consumer-run"} : {id: "call-1:presentation", runId: "source-run"}),
      to: expect.objectContaining({id: "request-replay", runId: "consumer-run"}),
      targetLocation: expect.objectContaining({jsonPointer: "/messages/1/content/0/result"})}));
    const records = (await query.query({...scope, kind: "list_records", limit: 100})).records;
    expect(records.filter(record => record.payload.kind === "working_view").map(record => record.payload)).toEqual([
      expect.objectContaining({stage: "included", requestId: "request-replay", recipientRunId: "consumer-run", selectionCount: actual.length, groupCount: 1}),
    ]);
    expect(records.filter(record => record.payload.kind === "working_selection")).toHaveLength(actual.length);
    if (ownerForm) {
      expect(records.find(record => record.payload.kind === "working_selection" && record.payload.sectionId === "history")?.payload)
        .toMatchObject({representation: "owner_form"});
      expect(graph.links).toContainEqual(expect.objectContaining({kind: "transforms", operation: "owner_presentation",
        from: expect.objectContaining({id: "history", runId: "source-run"}), to: expect.objectContaining({id: `${workingView.id}:selection:1`})}));
    }
    const groups = records.filter(record => record.payload.kind === "native_group");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.payload).toMatchObject({turnId: "source-turn", callCount: 1, settledCallCount: 1, status: "settled"});
    expect(groups[0]!.links).toContainEqual(expect.objectContaining({kind: "binding", from: expect.objectContaining({kind: "call", id: "call-1", runId: "source-run"}),
      to: expect.objectContaining({kind: "context", runId: "consumer-run"})}));
    expect(recorder.health().rejected).toBe(0);
  });

  it("shares source identity across producers and defers retirement while a reader holds a lease", async () => {
    const { directory, recorder, selection } = await setup();
    const other = await InspectionRecorder.create({ root: directory, application: "test", name: "Test" });
    cleanup.push(async () => other.flush(true));
    expect(other.source.sourceId).toBe(recorder.source.sourceId);
    expect(other.manifest.datasetId).not.toBe(recorder.manifest.datasetId);
    await recorder.flush(true);
    const release = acquireInspectionReadLease(datasetDirectory(directory, selection.sourceId, selection.datasetId));
    const options = { datasetId: selection.datasetId, before: "2099-01-01T00:00:00Z", apply: true };
    try { expect(retireInspectionDatasets(directory, selection.sourceId, options)[0]?.status).toBe("active"); }
    finally { release(); }
    expect(retireInspectionDatasets(directory, selection.sourceId, options)[0]?.status).toBe("removed");
    const query = new InspectionQueryService(directory);
    try { await expect(query.query({ kind: "get_snapshot", ...selection })).rejects.toThrow("inspection_dataset_cleared"); }
    finally { await query.close(); }
  });

  it("isolates a native body transaction failure and leaves earlier native facts readable", async () => {
    const { directory, recorder, query, subject, selection } = await setup(true);
    recorder.offer({ id: "before-fault", subject, occurredAt: null, payload: { kind: "event", name: "committed", sequence: null, code: null },
      contents: [{name: "body", stage: "received", class: "agent", mediaType: "text/plain", value: "persisted"}] });
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    const database = new Database(join(datasetDirectory(directory, selection.sourceId, selection.datasetId), "inspection.sqlite"));
    database.exec("CREATE UNIQUE INDEX injected_body_failure ON bodies(byte_length)"); database.close();
    expect(recorder.offer({ id: "failed-publication", subject, occurredAt: null, payload: { kind: "event", name: "fault", sequence: null, code: null }, contents: [{ name: "body", stage: "received", class: "agent", mediaType: "text/plain", value: "different" }] })).toBe(true);
    await recorder.flush();
    expect(recorder.health()).toMatchObject({ available: false, code: "inspection_storage_unavailable", queued: 0 });
    expect(recorder.health().dropped).toBe(0);
    expect(recorder.health().unconfirmed + recorder.health().unpersisted).toBeGreaterThan(0);
    expect(recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "after fault", sequence: null, code: null } })).toBe(false);
    expect((await query.query({ kind: "list_records", ...snapshot })).records.map((record) => record.id)).toEqual(["before-fault"]);
    await expect(recorder.flush(true)).resolves.toMatchObject({native: "failed", unpersisted: 1, unconfirmed: 0});
    expect(JSON.parse(readFileSync(join(datasetDirectory(directory, selection.sourceId, selection.datasetId), "manifest.json"), "utf8"))).toMatchObject({
      status: "closed", captureFailure: "inspection_storage_unavailable",
    });
    expect(retireInspectionDatasets(directory, selection.sourceId, { datasetId: selection.datasetId, before: new Date().toISOString(), apply: true })[0]?.status).toBe("removed");
  });

  it("bounds query concurrency, cancels without changing records, and pages telemetry at the same watermark", async () => {
    const { recorder, query, subject, selection } = await setup();
    for (let i = 0; i < 6; i++) recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "page", sequence: i, code: null } });
    await recorder.flush();
    const abort = new AbortController();
    const cancelled = query.query({ kind: "get_snapshot", ...selection }, abort.signal);
    const second = query.query({ kind: "get_snapshot", ...selection });
    await expect(query.query({ kind: "get_snapshot", ...selection })).rejects.toThrow("inspection_query_busy");
    abort.abort();
    await expect(cancelled).rejects.toThrow("inspection_query_cancelled");
    const snapshot = (await second).selection!;
    const first = await query.query({ kind: "get_telemetry", ...snapshot, limit: 2 });
    const next = await query.query({ kind: "get_telemetry", ...snapshot, limit: 2, after: String(first.next) });
    expect(first.telemetry).toHaveLength(2); expect(next.telemetry).toHaveLength(2);
    expect(next.telemetry[0]).not.toEqual(first.telemetry[0]);
    expect((await query.query({ kind: "list_records", ...snapshot })).records).toHaveLength(6);
    expect(() => query.query({ kind: "get_subject", ...snapshot, subject: { ...subject, datasetId: "different" } })).toThrow("inspection_access_denied");
  });

  it("preserves historical watermarks, Run-scoped scheduling and unknown interval coverage", async () => {
    const { recorder, query, subject, selection } = await setup();
    recorder.offer({ id: "initial", subject, occurredAt: null, payload: { kind: "snapshot", status: "running", revision: 1, agentId: "agent", parentRunId: null, taskId: "task" } });
    await recorder.flush();
    const first = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    recorder.offer({ id: "queued", subject: recorder.ref("runtime", "call", "call", subject.id), occurredAt: null, payload: { kind: "scheduling", position: 0, disposition: "queued", rule: "serial", reason: null, groupId: "decision" } });
    recorder.offer({ subject, occurredAt: "2026-09-09T00:00:03Z", payload: { kind: "interval", phase: "settled", activity: "run", status: "succeeded", clock: "source" } });
    await recorder.flush();
    const latest = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    expect((await query.query({ kind: "get_snapshot", ...first })).selection).toEqual(first);
    expect((await query.query({ kind: "get_scheduling", ...latest, subject })).records.map((record) => record.id)).toEqual(["queued"]);
    expect((await query.query({ kind: "get_timeline", ...latest })).limitations).toContain("interval_start_not_observed");
    expect((await query.query({ kind: "get_record", ...first, recordId: "queued" })).records).toEqual([]);
  });
  it("uses actual Run span contexts for descendants and retains state across later events", async () => {
    const { recorder, query, subject, selection } = await setup();
    const child = recorder.ref("runtime", "run", "child", "child");
    for (const [ref, phase, time] of [[subject, "started", "00"], [child, "started", "01"], [child, "settled", "02"], [subject, "settled", "03"]] as const) {
      recorder.offer({ subject: ref, occurredAt: `2026-09-09T00:00:${time}Z`, payload: { kind: "interval", phase, activity: "run", status: phase === "settled" ? "succeeded" : null, clock: "clock" },
        links: ref === child && phase === "started" ? [{ from: subject, to: child, kind: "descendant", condition: null, operation: null, sourceLocation: null, targetLocation: null }] : [] });
    }
    recorder.offer({ subject, occurredAt: null, payload: { kind: "snapshot", status: "succeeded", revision: 9, agentId: "agent", parentRunId: null, taskId: "task" } });
    recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "late diagnostic", sequence: null, code: null } });
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    expect((await query.query({ kind: "get_subject", ...snapshot, subject })).records[0]?.payload).toMatchObject({ kind: "snapshot", status: "succeeded" });
    const spans = (await query.query({ kind: "get_telemetry", ...snapshot })).telemetry.filter((item: any) => item.kind === "span") as any[];
    const parent = spans.find((item) => item.value.links.length === 0);
    const descendant = spans.find((item) => item.value.links.length === 1);
    expect(parent.value.parentSpanContext).toBeNull();
    expect(descendant.value.parentSpanContext).toBeNull();
    expect(descendant.value.links[0].context).toEqual(parent.value.context);
    expect(descendant.value.context.traceId).not.toBe(parent.value.context.traceId);
  });

  it.each(["descendant_run", "descendant_result_transfer"])("joins raw Child result through %s, Context admission and projection without inventing dependencies", async (kind) => {
    const { recorder, query, selection } = await setup(true);
    const execution = new RunExecutionInspectionAdapter(recorder);
    const transcript = new RunTranscriptInspectionAdapter(recorder);
    const now = "2026-09-09T00:00:00Z";
    const projected = { ref: { id: "delegation-result", revision: "1" }, correlation: {relation: {ref: {id: "relation"}}}, output: { answer: "child result" } };
    execution.observe({ kind: "descendant_result", runId: "run-1", occurredAt: now, parentRunActionId: "action", raw: { runId: "child", output: "raw" }, projected } as never);
    const observation = { id: "observation", owner: "agent-runtime", runId: "run-1", runAction: { id: "action" }, createdAt: now,
      lowerRefs: [{owner: "agent-runtime", kind: "delegation_result", id: projected.ref.id, revision: projected.ref.revision}],
      payload: { kind, ...(kind === "descendant_result_transfer" ? {result: projected} : {childRunId: "child"}), output: "delivered" } };
    transcript.observe({ runId: "run-1", sequence: 1, item: { ref: { id: "item", sequence: 1 }, createdAt: now, payload: { kind: "observation", observation } } } as never);
    const context = { ref: { id: "context", runId: "run-1", version: 1 }, createdAt: now, items: [{ ref: { id: "context-item" }, lifecycle: { kind: "active" }, contribution: { ref: { id: "contribution", revision: "1" }, source: { owner: "agent-runtime", kind: "run_observation", id: "observation", revision: "1" }, payload: { kind: "text", text: "delivered" } } }] };
    execution.observe({ kind: "context_committed", runId: "run-1", occurredAt: now, context } as never);
    execution.observe({ kind: "context_projection", runId: "run-1", occurredAt: now,
      projection: { blocks: [{ item: { id: "context-item" }, payload: { kind: "text", text: "delivered" } }] },
      manifest: { id: "manifest", activeContext: context.ref, projectionId: "projection", records: [{ item: { id: "context-item" }, contribution: { id: "contribution", revision: "1" }, disposition: "included", reason: "included_exact", transformation: null }] },
    } as never);
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    const flow = (await query.query({ kind: "get_data_flow", ...snapshot })).graph!;
    expect(flow.links.map((link) => link.kind)).toEqual(expect.arrayContaining(["transforms", "delivers", "produces", "includes"]));
    expect(flow.links.some((link) => link.targetLocation?.jsonPointer === "/blocks/0")).toBe(true);
    const delivered = flow.links.find(link => link.kind === "delivers")!;
    expect(delivered.from).toMatchObject({owner: "agent-runtime", id: "delegation-result", revision: "1"});
    const manifest = await query.query({kind: "get_subject", ...snapshot, subject: recorder.ref("context", "context", "manifest", "run-1")});
    const manifestLocation = manifest.records[0]!.links.find(link => link.sourceLocation)?.sourceLocation!;
    expect((await query.query({kind: "get_content", ...snapshot, contentId: manifestLocation.contentId!})).content?.text).toContain('"projectionId":"projection"');
    expect((await query.query({ kind: "get_dependencies", ...snapshot })).graph?.links).toHaveLength(0);
    expect(recorder.health().rejected).toBe(0);
  });

  it("redacts encoded JSON, distinguishes missing source content, and bounds saturated ingress", async () => {
    const { recorder, query, subject, selection } = await setup(true);
    recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "body", sequence: null, code: null }, contents: [
      { name: "encoded", class: "agent", stage: "encoded_json", mediaType: "text/plain", value: '{"apiKey":"private-key","text":"visible"}' },
      { name: "missing", class: "agent", stage: "received", mediaType: "application/json", value: null, unavailableReason: "source_limit" },
    ] });
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    const record = (await query.query({ kind: "list_records", ...snapshot })).records[0]!;
    const content = (await query.query({ kind: "get_content", ...snapshot, contentId: record.contents[0]!.id })).content!;
    expect(content.text).not.toContain("private-key"); expect(content.descriptor.redacted).toBe(true);
    expect(record.contents[1]).toMatchObject({ availability: "unavailable", unavailableReason: "source_limit" });
    for (let i = 0; i < 4200; i++) recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "load", sequence: i, code: null } });
    expect(recorder.health().queued).toBeLessThanOrEqual(4096);
    expect(recorder.health().dropped).toBeGreaterThan(0);
  });
  it("commits ongoing native facts before span end and projects correlated ended telemetry", async () => {
    const { recorder, query, subject, selection } = await setup();
    expect(recorder.offer({ id: "start", subject, occurredAt: "2026-09-09T00:00:00Z", payload: { kind: "interval", phase: "started", activity: "run", status: null, clock: "producer" } })).toBe(true);
    await recorder.flush();
    const snapshot = await query.query({ kind: "get_snapshot", ...selection });
    const watermark = snapshot.selection!.watermark;
    const ongoing = await query.query({ kind: "list_records", ...selection, watermark });
    expect(ongoing.records).toHaveLength(1);
    expect((await query.query({ kind: "get_telemetry", ...selection, watermark })).telemetry).toHaveLength(0);
    recorder.offer({ id: "end", subject, occurredAt: "2026-09-09T00:00:01Z", payload: { kind: "interval", phase: "settled", activity: "run", status: "succeeded", clock: "producer" } });
    await recorder.flush();
    const newer = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    expect((await query.query({ kind: "get_telemetry", ...newer })).telemetry).toHaveLength(1);
    expect((await query.query({ kind: "list_records", ...selection, watermark })).records).toHaveLength(1);
    await recorder.flush(true);
    expect((await query.query({ kind: "get_snapshot", ...selection })).coverage?.status).toBe("closed");
  });
  it("excludes disabled content and strips known credential keys from opted-in data", async () => {
    const { recorder, query, subject, selection } = await setup(true);
    recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "test", sequence: null, code: null }, contents: [{ name: "state", stage: "committed", class: "agent", mediaType: "application/json", value: { text: "visible", apiKey: "never-return" } }, { name: "response", stage: "response", class: "provider", mediaType: "text/plain", value: "not-retained" }] });
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    const records = (await query.query({ kind: "list_records", ...snapshot })).records;
    expect(records[0]!.contents[1]!.availability).toBe("not_captured");
    const content = (await query.query({ kind: "get_content", ...snapshot, contentId: records[0]!.contents[0]!.id })).content!;
    expect(content.text).toContain("visible"); expect(content.text).not.toContain("never-return"); expect(content.descriptor.redacted).toBe(true);
  });
  it("deduplicates identities, reports conflicts and rejects invalid or executable payloads", async () => {
    const { recorder, query, subject, selection } = await setup();
    const input = { id: "same", subject, occurredAt: null, payload: { kind: "event" as const, name: "test", sequence: null, code: null } };
    expect(recorder.offer(input)).toBe(true); expect(recorder.offer(input)).toBe(true);
    expect(recorder.offer({ ...input, payload: { ...input.payload, name: "conflict" } })).toBe(true);
    expect(recorder.offer({ ...input, payload: { kind: "missing" } } as never)).toBe(false);
    let invoked = false;
    expect(() => snapshotInspectionJson({ get value() { invoked = true; return "bad"; } })).toThrow();
    expect(invoked).toBe(false);
    await recorder.flush();
    const snapshot = await query.query({ kind: "get_snapshot", ...selection });
    expect(snapshot.coverage?.captured).toBe(1); expect(snapshot.coverage?.rejected).toBeGreaterThan(0);
    expect(snapshot.coverage?.limitations).toContain("conflicting_record_identity");
  });
  it.each(["agent", "provider", "execution"] as const)("returns uncaptured %s metadata regardless of later capture settings", async (kind) => {
    const { recorder, query, subject, selection } = await setup();
    recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "uncaptured", sequence: null, code: null }, contents: [{ name: kind, stage: "received", class: kind, mediaType: "text/plain", value: "never retained" }] });
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    const descriptor = (await query.query({ kind: "list_records", ...snapshot })).records[0]!.contents[0]!;
    const input = { kind: "get_content" as const, ...snapshot, contentId: descriptor.id };
    const expected = { descriptor: { availability: "not_captured", retainedBytes: 0, digest: null }, text: "", nextOffset: null };
    expect((await query.query(input)).content).toMatchObject(expected);
    recorder.setPolicy({ ...DEFAULT_INSPECTION_CAPTURE_POLICY, revision: "disabled", enabled: false });
    expect((await query.query(input)).content).toMatchObject(expected);
    recorder.setPolicy({ ...DEFAULT_INSPECTION_CAPTURE_POLICY, revision: "enabled", agent: true, provider: true, execution: true });
    expect((await query.query(input)).content).toMatchObject(expected);
  });
  it("keeps unavailable source content distinct from a revoked retained body", async () => {
    const { recorder, query, subject, selection } = await setup(true);
    recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "missing", sequence: null, code: null }, contents: [{ name: "body", stage: "received", class: "agent", mediaType: "text/plain", value: null, unavailableReason: "source_limit" }] });
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    const descriptor = (await query.query({ kind: "list_records", ...snapshot })).records[0]!.contents[0]!;
    recorder.setPolicy({ ...DEFAULT_INSPECTION_CAPTURE_POLICY, revision: "revoked" });
    expect((await query.query({ kind: "get_content", ...snapshot, contentId: descriptor.id })).content).toMatchObject({ descriptor: { availability: "unavailable", unavailableReason: "source_limit" }, text: "", nextOffset: null });
  });
  it("revokes historical content access without deleting retained records", async () => {
    const { recorder, query, subject, selection } = await setup(true);
    recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "content", sequence: null, code: null }, contents: [{ name: "body", stage: "received", class: "agent", mediaType: "text/plain", value: "retained" }] });
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    const record = (await query.query({ kind: "list_records", ...snapshot })).records[0]!;
    recorder.setPolicy({ ...DEFAULT_INSPECTION_CAPTURE_POLICY, revision: "revoked" });
    await recorder.flush();
    await expect(query.query({ kind: "get_content", ...snapshot, contentId: record.contents[0]!.id })).rejects.toThrow("inspection_access_denied");
    expect((await query.query({ kind: "list_records", ...snapshot })).records).toHaveLength(1);
  });
  it("reports damaged content and retires only explicitly closed datasets", async () => {
    const { directory, recorder, query, subject, selection } = await setup(true);
    recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "content", sequence: null, code: null }, contents: [{ name: "body", stage: "received", class: "agent", mediaType: "text/plain", value: "retained" }] });
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    const id = (await query.query({ kind: "list_records", ...snapshot })).records[0]!.contents[0]!.id;
    const database = new Database(join(datasetDirectory(directory, subject.sourceId, subject.datasetId), "inspection.sqlite"));
    database.prepare("UPDATE bodies SET bytes=? WHERE id=(SELECT body_id FROM contents WHERE id=?)").run(Buffer.from("damaged"), id); database.close();
    expect((await query.query({ kind: "get_content", ...snapshot, contentId: id })).content?.descriptor.availability).toBe("unavailable");
    const options = { before: "2099-01-01T00:00:00Z", apply: true };
    expect(retireInspectionDatasets(directory, subject.sourceId, options)[0]?.status).toBe("active");
    await recorder.flush(true);
    expect(retireInspectionDatasets(directory, subject.sourceId, { ...options, apply: false })[0]?.status).toBe("eligible");
    expect(retireInspectionDatasets(directory, subject.sourceId, options)[0]?.status).toBe("removed");
  });
});
