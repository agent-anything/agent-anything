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
import {
  ModelInteractionProjectionError,
  projectModelInteraction,
} from "./ModelInteractionProjection.js";

describe("ModelInteractionProjection", () => {
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
