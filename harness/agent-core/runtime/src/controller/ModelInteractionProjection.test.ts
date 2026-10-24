import { describe, expect, it } from "vitest";
import {
  createModelCallRef,
  snapshotModelToolCall,
  snapshotModelToolResult,
  type ModelToolCall,
  type ModelTurn,
} from "@agent-anything/model-interaction";
import type { RunItem } from "../run/RunItem.js";
import { createControllerModelItems } from "./ControllerModelItems.js";
import { createModelConversationSeed, selectConversationPresentations, canonicalConversationPresentations, importModelConversationSeed } from "./ControllerConversation.js";
import {createExactModelWorkingView, modelInputOccurrenceDigest, type ModelInputOwnerForm} from "@agent-anything/model-interaction/input";
import { createControllerInputDeliveryReceipt, createInputDeliverySections, inputNotificationMessage, retainInputPresentation } from "./ControllerInputDelivery.js";
import {
  ModelInteractionProjectionError,
  projectModelInteraction,
} from "./ModelInteractionProjection.js";

describe("ModelInteractionProjection", () => {
  it("exports the selected owner form to a continued Child without rewriting canonical source history", () => {
    const source = {owner: "test-source", kind: "report", id: "finding", revision: "1", runId: "run-1"};
    const presentation = retainInputPresentation({id: "finding", source, kind: "interaction_history", role: "user", necessity: "mandatory",
      content: {kind: "text", text: "Account\nOriginal detail"},
      preservation: {obligations: [{id: "finding", requirement: "account", basis: "Explicit owner account"}], relationships: []},
      provenance: {purpose: "accepted_exchange", recipientRunId: "run-1", author: "host", sources: [source],
        presenter: source, coverage: ["finding@1"], limitations: [], retainedPresentation: source}});
    const form: ModelInputOwnerForm = {id: "finding-account", sectionId: "finding", sourceDigest: modelInputOccurrenceDigest(presentation.section),
      owner: {...source, kind: "presenter"}, method: "exact_extract", content: {kind: "text", text: "Account"}, extract: {start: 0, end: 7},
      satisfies: ["finding"], companions: [], dependencies: [], limitations: ["Owner-approved account"]};
    const projection = {...projectModelInteraction({runId: "run-1", runRevision: 0, items: []}), historyPresentations: [presentation],
      workingView: createExactModelWorkingView({sections: [presentation.section], recipientRunId: "run-1", boundary: "history"}), workingForms: [form]};
    const selected = selectConversationPresentations(projection);
    expect(selected[0]?.section.content).toEqual(form.content);
    expect(canonicalConversationPresentations(projection)[0]?.section.content).toEqual({kind: "text", text: "Account\nOriginal detail"});
    const seed = createModelConversationSeed("run-1", "3", selected);
    const imported = importModelConversationSeed(JSON.parse(JSON.stringify(seed)), "continued-child");
    expect(imported[0]?.section.content).toEqual(form.content);
    expect(imported[0]?.section.provenance).toMatchObject({recipientRunId: "continued-child", originRunId: "run-1",
      presenter: form.owner, limitations: form.limitations});
    expect(imported[0]?.section.source).toEqual(source);
  });
  it("keeps each delivered feedback occurrence at its consuming response, not at the current tail", () => {
    const feedback = {source: {owner: "controller", kind: "protocol", id: "protocol", revision: "1"},
      code: "ending_required", message: "Submit an ending proposal."};
    const history: RunItem[] = [runItem(1, controllerTurn(modelTurn([])))];
    for (let sequence = 1; sequence <= 2; sequence++) {
      const turn = {id: `controller-turn-${sequence}`, run: {id: "run-1"}, sequence};
      const entry = {runId: "run-1", sequence, source: {owner: "agent-runtime", kind: "controller_feedback",
        id: `${turn.id}:feedback`, revision: String(sequence)}, occurredAt: "2026-10-20T00:00:00.000Z",
        data: feedback, interpretation: {kind: "controller_feedback" as const, turn}};
      const batch = {id: `batch-${sequence}`, revision: "1", runId: "run-1", entries: [entry]};
      const receipt = {...createControllerInputDeliveryReceipt(batch, `request-${sequence + 1}`),
        via: {kind: "provider" as const, requestId: `request-${sequence + 1}`, compositionId: `composition-${sequence}`, workingViewId: `view-${sequence}`,
          sectionIds: createInputDeliverySections(batch).map(section => section.id), presentations: createInputDeliverySections(batch).map(retainInputPresentation)}};
      const next = controllerTurn(modelTurn([], `turn-${sequence + 1}`, `request-${sequence + 1}`));
      if (next.kind !== "controller_turn") throw new Error("Invalid fixture");
      const delivery = runItem(history.length + 1, {kind: "input_delivery", batch, receipt, turn: next.turn});
      history.push(delivery, {...runItem(history.length + 2, next), committedInRevision: delivery.committedInRevision});
      const projected = projectModelInteraction({runId: "run-1", runRevision: history.length, items: history});
      expect(projected.messages[sequence * 2 - 1]).toEqual(inputNotificationMessage(entry));
    }
    const projected = projectModelInteraction({runId: "run-1", runRevision: history.length, items: history});
    expect(projected.messages.map(message => message.role)).toEqual(["assistant", "user", "assistant", "user", "assistant"]);
    expect(projected.notificationHistory?.map(entry => entry.sequence)).toEqual([1, 2]);
  });
  it("replays accepted notifications after the complete result group and before their consuming Turn", () => {
    const call = modelCall("read", 0);
    const batch = {id: "batch-1", revision: "1", runId: "run-1", entries: [{runId: "run-1", sequence: 1,
      source: {owner: "execution", kind: "process", id: "process-1", revision: "2"},
      occurredAt: "2026-10-13T00:00:00.000Z", data: {exitCode: 0}}]};
    const controllerReceipt = createControllerInputDeliveryReceipt(batch, "request-2");
    const receipt = {...controllerReceipt, via: {kind: "provider" as const, requestId: "request-2", compositionId: "request-2", workingViewId: "view-2",
      sectionIds: createInputDeliverySections(batch).map(section => section.id), presentations: createInputDeliverySections(batch).map(retainInputPresentation)}};
    const next = controllerTurn(modelTurn([], "turn-2", "request-2"));
    if (next.kind !== "controller_turn") throw new Error("Invalid fixture");
    const delivery = runItem(3, {kind: "input_delivery", batch, receipt, turn: next.turn});
    const nextItem = {...runItem(4, next), committedInRevision: 3};
    const history = [runItem(1, controllerTurn(modelTurn([call]))), runItem(2, settlement(call, "succeeded")), delivery, nextItem];
    const projection = projectModelInteraction({runId: "run-1", runRevision: 3, items: history});
    expect(projection.messages.map(message => message.role)).toEqual(["assistant", "tool", "user", "assistant"]);
    expect(projection.notificationHistory).toMatchObject([{messageIndex: 2, batchId: "batch-1", batchRevision: "1", sequence: 1}]);
    expect(JSON.stringify(projection.messages).match(/host_notification/g)).toHaveLength(1);
    expect(() => projectModelInteraction({runId: "run-1", runRevision: 3, items: [history[0]!, delivery, nextItem]}))
      .toThrowError(expect.objectContaining({code: "input_delivery_history_invalid"}));
    expect(() => projectModelInteraction({runId: "run-1", runRevision: 4, items: [...history.slice(0, 3), runItem(4, next)]}))
      .toThrowError(expect.objectContaining({code: "input_delivery_history_invalid"}));
    const mismatched = {...delivery, payload: {...delivery.payload, receipt: {...receipt,
      via: {...receipt.via, requestId: "another-request"}}}} as RunItem;
    expect(() => projectModelInteraction({runId: "run-1", runRevision: 3, items: [history[0]!, history[1]!, mismatched, nextItem]}))
      .toThrowError(expect.objectContaining({code: "input_delivery_request_mismatch"}));
    const deterministic = {...delivery, payload: {...delivery.payload, receipt: controllerReceipt}} as RunItem;
    expect(projectModelInteraction({runId: "run-1", runRevision: 3, items: [history[0]!, history[1]!, deterministic, nextItem]})
      .messages.map(message => message.role)).toEqual(["assistant", "tool", "assistant"]);
  });
  it("projects exact admitted local text provenance, not seed messages or an older text-bearing Turn", () => {
    const source = {owner: "agent-runtime", kind: "run_item", id: "old-turn", revision: "1", runId: "old-child"};
    const seed = createModelConversationSeed("old-child", "1", [retainInputPresentation({id: "old-history", source,
      kind: "interaction_history", role: "assistant", necessity: "mandatory",
      content: {kind: "model_message", message: {role: "assistant", content: [{kind: "text", text: "Seed report"}]}},
      provenance: {purpose: "accepted_exchange", recipientRunId: "old-child", author: "model", sources: [source],
        presenter: source, coverage: ["old-turn@1"], limitations: []}})]);
    const imported = projectModelInteraction({runId: "run-1", runRevision: 0, items: [], seed});
    expect(imported.latestTurn).toBeNull();
    expect(imported.messages).toEqual([]);
    expect(imported.seed).toEqual(seed);
    const turn = modelTurn([]);
    const textTurn: ModelTurn = {...turn, assistant: {role: "assistant", content: [
      {kind: "text", text: " First "}, {kind: "text", text: "Second"},
    ]}};
    const first = runItem(1, controllerTurn(textTurn));
    expect(projectModelInteraction({runId: "run-1", runRevision: 1, items: [first], seed}).latestTurn)
      .toMatchObject({runId: "run-1", runItemId: first.ref.id, runItemSequence: 1, turnId: turn.turnId,
        textBlocks: [{ordinal: 0, text: " First "}, {ordinal: 1, text: "Second"}]});
    const later = modelTurn([], "turn-2", "request-2");
    expect(projectModelInteraction({runId: "run-1", runRevision: 2, items: [first, runItem(2, controllerTurn(later))]}).latestTurn)
      .toMatchObject({turnId: "turn-2", textBlocks: []});
  });
  it("rejects continuation seeds that omit a result or interrupt the native Call group", () => {
    const call = modelCall("read", 0);
    const projection = projectModelInteraction({runId: "run-1", runRevision: 2,
      items: [runItem(1, controllerTurn(modelTurn([call]))), runItem(2, settlement(call, "succeeded"))]});
    const presentations = projection.historyPresentations!;
    expect(createModelConversationSeed("run-1", "2", presentations).presentations).toHaveLength(2);
    expect(() => createModelConversationSeed("run-1", "2", presentations.slice(0, 1))).toThrow("unsettled Calls");
    expect(() => createModelConversationSeed("run-1", "2", presentations.slice(1))).toThrow("no matching Call");
    const interruption = retainInputPresentation({...presentations[0]!.section, id: "interruption", role: "user",
      content: {kind: "text", text: "New information"}});
    expect(() => createModelConversationSeed("run-1", "2", [presentations[0]!, interruption, presentations[1]!]))
      .toThrow("interrupts an unsettled");
  });

  it("preserves reasoning across transcript projection without moving native call ordinals", () => {
    const call = modelCall("read", 0);
    const turn = modelTurn([call]);
    const reasoning = { text: "Private protocol reasoning", replay: { format: "ollama.thinking.v1", binding: "scope" } };
    const result = projectModelInteraction({ runId: "run-1", runRevision: 2,
      items: [runItem(1, controllerTurn({ ...turn, assistant: { ...turn.assistant, reasoning } })), runItem(2, settlement(call, "succeeded"))] });
    expect(result.messages[0]).toMatchObject({ role: "assistant", reasoning, content: [{ kind: "model_tool_call", call: { ordinal: 0 } }] });
  });
  it("reconstructs ordered assistant calls and correlated settlements", () => {
    const calls = [modelCall("read", 0), modelCall("search", 1)];
    const items = [
      runItem(1, controllerTurn(modelTurn(calls))),
      runItem(2, settlement(calls[1]!, "denied")),
      runItem(3, settlement(calls[0]!, "succeeded")),
    ];

    const projection = projectModelInteraction({
      runId: "run-1",
      runRevision: 3,
      items,
    });

    expect(projection).toMatchObject({
      id: "run-1:model-interaction",
      revision: "3",
      unsettledCalls: [],
      settledCallCount: 2,
    });
    expect(projection.messages).toHaveLength(2);
    expect(projection.messages[0]).toMatchObject({
      role: "assistant",
      content: [
        { kind: "model_tool_call", call: { name: "read", ordinal: 0 } },
        { kind: "model_tool_call", call: { name: "search", ordinal: 1 } },
      ],
    });
    expect(projection.messages[1]).toMatchObject({
      role: "tool",
      content: [
        { kind: "model_tool_result", result: { name: "read", settlement: "succeeded" } },
        { kind: "model_tool_result", result: { name: "search", settlement: "denied" } },
      ],
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.messages)).toBe(true);
  });

  it("exposes an unsettled call without inventing a result", () => {
    const call = modelCall("read", 0);
    const projection = projectModelInteraction({
      runId: "run-1",
      runRevision: 1,
      items: [runItem(1, controllerTurn(modelTurn([call])))],
    });

    expect(projection.unsettledCalls).toEqual([call]);
    expect(projection.settledCallCount).toBe(0);
    expect(projection.messages).toHaveLength(1);
  });

  it("retains accompanying text and calls together when reconstructing subsequent model history", () => {
    const call = modelCall("read", 1);
    const first = modelTurn([call]);
    const mixed: ModelTurn = { ...first, assistant: { role: "assistant", content: [
      { kind: "text", text: "I will inspect the file." },
      { kind: "model_tool_call", call },
      { kind: "text", text: "The result will inform the next action." },
    ] } };
    const later = modelTurn([], "turn-2", "request-2");
    const projection = projectModelInteraction({
      runId: "run-1",
      runRevision: 3,
      items: [
        runItem(1, controllerTurn(mixed)),
        runItem(2, settlement(call, "succeeded")),
        runItem(3, controllerTurn({ ...later, assistant: { role: "assistant", content: [
          { kind: "text", text: "The file has been inspected." },
        ] } })),
      ],
    });

    expect(projection.messages.map(message => message.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(projection.messages[0]).toEqual(mixed.assistant);
    expect(projection.messages[1]).toMatchObject({ content: [{ result: {
      modelCallRef: call.modelCallRef, name: "read", settlement: "succeeded",
    } }] });
    expect(projection.messages[2]).toMatchObject({ content: [{ kind: "text", text: "The file has been inspected." }] });
    expect(projection.unsettledCalls).toEqual([]);
    expect(projection.settledCallCount).toBe(1);
  });

  it("rejects a next Controller turn while a prior call is unsettled", () => {
    const firstCall = modelCall("read", 0, "turn-1", "request-1");
    const secondTurn = modelTurn([], "turn-2", "request-2");

    expect(() => projectModelInteraction({
      runId: "run-1",
      runRevision: 2,
      items: [
        runItem(1, controllerTurn(modelTurn([firstCall], "turn-1", "request-1"))),
        runItem(2, controllerTurn(secondTurn)),
      ],
    })).toThrowError(expect.objectContaining({
      code: "model_call_unsettled_before_next_turn",
    }));
  });

  it("rejects duplicate and mismatched settlements", () => {
    const call = modelCall("read", 0);
    const first = runItem(1, controllerTurn(modelTurn([call])));
    const result = settlement(call, "succeeded");

    expect(() => projectModelInteraction({
      runId: "run-1",
      runRevision: 3,
      items: [first, runItem(2, result), runItem(3, result)],
    })).toThrowError(expect.objectContaining({
      code: "model_call_settlement_uncorrelated",
    }));

    const mismatched = settlement({ ...call, name: "search" }, "failed");
    expect(() => projectModelInteraction({
      runId: "run-1",
      runRevision: 2,
      items: [first, runItem(2, mismatched)],
    })).toThrowError(expect.objectContaining({
      code: "model_call_settlement_mismatch",
    }));
  });

  it("uses a typed projection error", () => {
    expect(() => projectModelInteraction({
      runId: "run-1",
      runRevision: 1,
      items: [runItem(1, settlement(modelCall("read", 0), "failed"))],
    })).toThrow(ModelInteractionProjectionError);
  });
});

function modelCall(
  name: string,
  ordinal: number,
  turnId = "turn-1",
  providerRequestId = "request-1",
): ModelToolCall {
  return snapshotModelToolCall({
    modelCallRef: createModelCallRef({
      providerRequestId,
      controllerRequestId: `${turnId}:controller`,
      turnId,
      contentBlockOrdinal: ordinal,
      branchId: "run-1:main",
    }),
    providerCallRef: { providerId: "provider-1", id: `provider-call-${ordinal}` },
    name,
    input: { path: `${name}.txt` },
    ordinal,
  });
}

function modelTurn(
  calls: readonly ModelToolCall[],
  turnId = "turn-1",
  requestId = "request-1",
): ModelTurn {
  return {
    turnId,
    assistant: {
      role: "assistant",
      content: calls.map((call) => ({ kind: "model_tool_call" as const, call })),
    },
    finish: { kind: "normal" },
    usage: null,
    responseRef: { providerId: "provider-1", requestId, responseId: `${turnId}:response` },
  };
}

function controllerTurn(turn: ModelTurn): RunItem["payload"] {
  return {
    kind: "controller_turn",
    turn: { run: { id: "run-1" }, id: `${turn.turnId}:controller`, sequence: 1 },
    status: "decided",
    decisionKind: "advance",
    instructionBinding: { id: "instruction-1", revision: "1" },
    toolExposure: {} as never,
    modelItems: createControllerModelItems(turn),
    failure: null,
  };
}

function settlement(
  call: ModelToolCall,
  kind: "succeeded" | "failed" | "denied",
): RunItem["payload"] {
  return {
    kind: "model_call_settlement",
    result: snapshotModelToolResult({
      modelCallRef: call.modelCallRef,
      providerCallRef: call.providerCallRef,
      name: call.name,
      settlement: kind,
      presentation: {presenter: {id: "test", revision: "1"}, disposition: "complete", failureCode: null},
      content: { status: kind },
      sourceRefs: [{ owner: "agent-runtime", kind: "run_action", id: "action-1", revision: "1" }],
    }),
  };
}

function runItem(sequence: number, payload: RunItem["payload"]): RunItem {
  return {
    ref: { run: { id: "run-1" }, id: `item-${sequence}`, sequence },
    committedInRevision: sequence,
    createdAt: "2026-08-27T00:00:00.000Z",
    payload,
  };
}
