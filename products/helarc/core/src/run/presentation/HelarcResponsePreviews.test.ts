import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControllerResponseObservation } from "@agent-anything/agent-runtime/controller";
import type { ProviderDeliveryEvent } from "@agent-anything/model-interaction";
import type { RunTranscriptRecord } from "@agent-anything/agent-runtime/transcript";
import { HelarcResponsePreviewStore } from "./HelarcResponsePreviews.js";
import type { HelarcModelCallableCatalog } from "../../controller/HelarcModelCallableCatalog.js";

function delivery(
  sequence: number,
  event: ProviderDeliveryEvent,
  runId = "root",
  invocationId = "attempt-1",
): ControllerResponseObservation {
  return {
    kind: "delivery",
    runId,
    progress: {
      ...event,
      sequence,
      invocationId,
      requestId: `${runId}:request`,
      controllerRequestId: `${runId}:controller`,
    },
  };
}
function interpreted(
  disposition: "validated" | "rejected" = "validated",
): ControllerResponseObservation {
  return {
    kind: "interpretation",
    runId: "root",
    requestId: "root:request",
    controllerRequestId: "root:controller",
    invocationId: "attempt-1",
    disposition,
    parts:
      disposition === "validated"
        ? [
            {
              partId: "text:0",
              turnId: "turn-1",
              contentBlockOrdinal: 0,
              modelItemId: "text-1",
            },
          ]
        : [],
  };
}
describe("response display previews", () => {
  it.each(["root", "child"])("settles %s reasoning independently of text/call ordinals", runId => {
    const store = new HelarcResponsePreviewStore(() => {});
    store.observe(delivery(1, { kind: "started", mode: "streaming" }, runId));
    store.observe(delivery(2, { kind: "reasoning_delta", partId: "reasoning:0", offset: 0, text: "Consider" }, runId));
    store.observe(delivery(3, { kind: "text_delta", partId: "text:0", offset: 0, text: "Answer" }, runId));
    store.observe(delivery(4, { kind: "settled", disposition: "completed", code: null,
      reasoning: { partId: "reasoning:0", turnId: "turn-1" },
      parts: [{ partId: "text:0", turnId: "turn-1", contentBlockOrdinal: 0 }] }, runId));
    store.observe({ ...interpreted(), runId, requestId: `${runId}:request`, controllerRequestId: `${runId}:controller` });
    expect(store.snapshot().attempts[0]).toMatchObject({ state: "validated", parts: [
      { kind: "reasoning", modelItemId: "turn-1:reasoning", turnId: "turn-1", text: "Consider" },
      { kind: "text", modelItemId: "text-1", text: "Answer" },
    ] });
    store.close();
  });
  afterEach(() => vi.useRealTimers());
  it("timestamps actual observations without a reader changing their recency", () => {
    let at = "2026-09-30T00:00:00.000Z";
    const store = new HelarcResponsePreviewStore(() => {}, () => at);
    store.observe(delivery(1, {kind: "started", mode: "streaming"}, "child"));
    expect(store.snapshot().attempts[0]?.observedAt).toBe(at);
    at = "2026-09-30T00:00:01.000Z";
    expect(store.snapshot().attempts[0]?.observedAt).not.toBe(at);
    store.observe(delivery(2, {kind: "text_delta", partId: "text:0", offset: 0, text: "Reading"}, "child"));
    expect(store.snapshot().attempts[0]?.observedAt).toBe(at);
    store.close();
  });
  it("streams only request-bound final controls and reconciles full arguments without calling them final", () => {
    const store = new HelarcResponsePreviewStore(() => {});
    store.bindRequest("root", "root:request", { bindings: [
      { kind: "control", control: "final_result", callableName: "final_result" },
    ] } as HelarcModelCallableCatalog);
    store.observe(delivery(1, { kind: "started", mode: "streaming" }));
    store.observe(delivery(2, { kind: "tool_call_delta", partId: "call:0", index: 0,
      name: "final_result", argumentsDelta: '{"response":"Partial' }));
    store.observe(delivery(3, { kind: "tool_call_delta", partId: "call:1", index: 1,
      name: "final_result_unknown", argumentsDelta: '{"response":"Not bound"}' }));
    expect(store.snapshot().attempts[0]).toMatchObject({ state: "receiving", parts: [
      { kind: "final_response", text: "Partial", modelItemId: null },
      { kind: "tool_call", text: "" },
    ] });
    store.observe(delivery(4, { kind: "settled", disposition: "completed", code: null, parts: [] }));
    store.observe({ ...interpreted(), parts: [
      { partId: "call:0", turnId: "turn-1", contentBlockOrdinal: 0, modelItemId: "final-item" },
      { partId: "call:1", turnId: "turn-1", contentBlockOrdinal: 1, modelItemId: "other-item" },
    ] });
    store.committed({ runId: "root", item: { payload: { kind: "controller_turn", modelItems: [
      { id: "final-item", kind: "model_tool_call", metadata: { helarcCallableBinding: { kind: "control", control: "final_result" } },
        call: { input: { response: "  Reconciled final candidate  " } } },
      { id: "other-item", kind: "model_tool_call" },
    ] } } } as RunTranscriptRecord);
    expect(store.snapshot().attempts[0]).toMatchObject({ state: "committed", parts: [
      { kind: "final_response", text: "  Reconciled final candidate  ", committedRecordId: "final-item" },
      { kind: "tool_call", text: "" },
    ] });
    store.close();
  });
  it("isolates final arguments across retries and excludes unbound child calls", () => {
    const store = new HelarcResponsePreviewStore(() => {});
    store.bindRequest("root", "root:request", { bindings: [
      { kind: "control", control: "final_result", callableName: "final_result" },
    ] } as HelarcModelCallableCatalog);
    for (const [run, invocation, response] of [["root", "first", "old"], ["root", "retry", "new"], ["child", "child", "child"]]) {
      store.observe(delivery(1, { kind: "started", mode: "streaming" }, run, invocation));
      store.observe(delivery(2, { kind: "tool_call_delta", partId: "call:0", index: 0,
        name: "final_result", argumentsDelta: JSON.stringify({ response }) }, run, invocation));
      store.observe(delivery(3, { kind: "settled", disposition: "failed", code: "connection", parts: [] }, run, invocation));
    }
    expect(store.snapshot().attempts.map(a => a.parts[0]?.text)).toEqual(["old", "new", ""]);
    expect(store.snapshot().attempts.every(a => a.state === "failed")).toBe(true);
    store.close();
  });
  it("coalesces many chunks and only reconciles the exact committed item", () => {
    vi.useFakeTimers();
    const checkpoint = vi.fn();
    const store = new HelarcResponsePreviewStore(checkpoint);
    store.observe(delivery(1, { kind: "started", mode: "streaming" }));
    for (let i = 0; i < 500; i++)
      store.observe(
        delivery(i + 2, {
          kind: "text_delta",
          partId: "text:0",
          offset: i,
          text: "x",
        }),
      );
    expect(checkpoint).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(checkpoint).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(checkpoint).toHaveBeenCalledOnce();
    store.observe(
      delivery(502, {
        kind: "settled",
        disposition: "completed",
        code: null,
        parts: [{ partId: "text:0", turnId: "turn-1", contentBlockOrdinal: 0 }],
      }),
    );
    store.observe(interpreted());
    expect(store.snapshot().attempts[0]).toMatchObject({
      state: "validated",
      parts: [{ modelItemId: "text-1", committedRecordId: null }],
    });
    const record = (id: string) =>
      ({
        runId: "root",
        item: {
          payload: {
            kind: "controller_turn",
            modelItems: [{ id, kind: "assistant_text", text: "x".repeat(500) }],
          },
        },
      }) as RunTranscriptRecord;
    store.committed(record("same-text-but-other-id"));
    expect(store.snapshot().attempts[0]?.state).toBe("validated");
    store.committed(record("text-1"));
    expect(store.snapshot().attempts[0]).toMatchObject({
      state: "committed",
      parts: [{ committedRecordId: "text-1" }],
    });
    expect(checkpoint).toHaveBeenCalledTimes(2);
    const final = store.snapshot();
    store.close();
    vi.advanceTimersByTime(2000);
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(checkpoint.mock.calls.at(-1)?.[0]).toEqual(final);
  });
  it("isolates sibling attempts, rejected responses and retry material", () => {
    const store = new HelarcResponsePreviewStore(() => {});
    store.observe(delivery(1, { kind: "started", mode: "streaming" }));
    store.observe(
      delivery(1, { kind: "started", mode: "streaming" }, "child", "attempt-2"),
    );
    store.observe(
      delivery(2, {
        kind: "text_delta",
        partId: "text:0",
        offset: 0,
        text: "root",
      }),
    );
    store.observe(
      delivery(
        2,
        { kind: "text_delta", partId: "text:0", offset: 0, text: "child" },
        "child",
        "attempt-2",
      ),
    );
    store.observe(
      delivery(
        3,
        {
          kind: "settled",
          disposition: "interrupted",
          code: "network",
          parts: [],
        },
        "child",
        "attempt-2",
      ),
    );
    store.observe(
      delivery(
        4,
        { kind: "text_delta", partId: "text:0", offset: 5, text: "late" },
        "child",
        "attempt-2",
      ),
    );
    store.observe(
      delivery(3, {
        kind: "settled",
        disposition: "completed",
        code: null,
        parts: [],
      }),
    );
    store.observe(interpreted("rejected"));
    expect(
      store.snapshot().attempts.map((a) => [a.state, a.parts[0]?.text]),
    ).toEqual([
      ["rejected", "root"],
      ["interrupted", "child"],
    ]);
    store.close();
  });
  it("rejects duplicate/out-of-order chunks and does not create a preview for buffered calls", () => {
    const store = new HelarcResponsePreviewStore(() => {});
    store.observe(delivery(1, { kind: "started", mode: "buffered" }));
    expect(store.snapshot().attempts).toEqual([]);
    store.observe(delivery(1, { kind: "started", mode: "streaming" }));
    store.observe(
      delivery(2, {
        kind: "text_delta",
        partId: "text:0",
        offset: 0,
        text: "a",
      }),
    );
    store.observe(
      delivery(2, {
        kind: "text_delta",
        partId: "text:0",
        offset: 1,
        text: "duplicate",
      }),
    );
    store.observe(
      delivery(3, {
        kind: "text_delta",
        partId: "text:0",
        offset: 100,
        text: "gap",
      }),
    );
    expect(store.snapshot().attempts[0]?.parts[0]?.text).toBe("a");
    store.close();
    expect(store.snapshot().attempts[0]?.state).toBe("interrupted");
  });
  it("bounds preview retention without truncating a Provider result or retaining partial Tool inputs", () => {
    const store = new HelarcResponsePreviewStore(() => {});
    for (let i = 0; i < 25; i++) {
      const id = `attempt-${i}`;
      store.observe(
        delivery(1, { kind: "started", mode: "streaming" }, "root", id),
      );
      store.observe(
        delivery(
          2,
          {
            kind: "text_delta",
            partId: "text:0",
            offset: 0,
            text: "x".repeat(260000),
          },
          "root",
          id,
        ),
      );
      store.observe(
        delivery(
          3,
          {
            kind: "tool_call_delta",
            partId: "call:0",
            index: 0,
            name: "Read",
            argumentsDelta: '{"secret":"partial"}',
          },
          "root",
          id,
        ),
      );
      store.observe(
        delivery(
          4,
          { kind: "settled", disposition: "failed", code: "bad", parts: [] },
          "root",
          id,
        ),
      );
    }
    expect(store.snapshot().retainedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(store.snapshot().omittedAttempts).toBeGreaterThan(0);
    expect(JSON.stringify(store.snapshot())).not.toContain('"secret"');
    store.close();
  });
});
