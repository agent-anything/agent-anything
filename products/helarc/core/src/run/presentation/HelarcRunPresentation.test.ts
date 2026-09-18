import { describe, expect, it } from "vitest";
import type { RunTranscriptRecord } from "@agent-anything/agent-runtime/transcript";
import {
  appendHelarcRunPresentation,
  boundedPresentationText,
  createHelarcRunPresentation,
  labelHelarcRunPresentation,
  projectHelarcPresentationValue,
} from "./HelarcRunPresentation.js";

const at = "2026-09-18T00:00:00.000Z";
function record(
  sequence: number,
  payload: unknown,
  runId = "root",
): RunTranscriptRecord {
  return {
    runId,
    sequence,
    item: {
      ref: { run: { id: runId }, id: `${runId}-item-${sequence}`, sequence },
      committedInRevision: sequence,
      createdAt: at,
      payload,
    },
  } as RunTranscriptRecord;
}
const call = {
  id: "call",
  kind: "model_tool_call",
  call: {
    modelCallRef: { id: "call", turnId: "turn" },
    name: "Agent",
    input: { description: "Inspect files", prompt: "Inspect the repository" },
  },
};

describe("Run presentation", () => {
  it("uses exact sources, preserves nonfinal text and updates the requested call with settlement", () => {
    let state = appendHelarcRunPresentation(
      createHelarcRunPresentation(),
      record(1, {
        kind: "controller_turn",
        modelItems: [
          {
            kind: "assistant_text",
            id: "text",
            turnId: "turn",
            contentBlockOrdinal: 0,
            text: "I will inspect.",
          },
          call,
        ],
      }),
    );
    expect(appendHelarcRunPresentation(state, record(1, {}))).toBe(state);
    state = appendHelarcRunPresentation(
      state,
      record(2, {
        kind: "run_action",
        action: {
          ref: { id: "action" },
          provenance: { kind: "controller", modelCallRef: { id: "call" } },
          subject: { kind: "operation", invocationId: "invocation" },
        },
      }),
    );
    state = labelHelarcRunPresentation(
      state,
      "child",
      {
        kind: "descendant",
        root: { id: "root" },
        parent: { id: "root" },
        parentRunAction: { id: "action", run: { id: "root" }, sequence: 1 },
        relation: { id: "relation" },
        depth: 1,
      },
      "Root task",
    );
    expect(state.labels[0]).toMatchObject({
      label: "Inspect files",
      objective: "Inspect the repository",
      parentRunId: "root",
    });
    state = appendHelarcRunPresentation(
      state,
      record(3, {
        kind: "model_call_settlement",
        result: {
          modelCallRef: { id: "call" },
          settlement: "denied",
          content: { reason: "declined" },
        },
      }),
    );
    expect(state.records).toHaveLength(2);
    expect(state.records[1]).toMatchObject({
      source: { id: "root-item-1" },
      revision: 3,
      content: {
        runActionId: "action",
        invocationId: "invocation",
        settlement: "denied",
      },
    });
    expect(state.records[0]?.content).toMatchObject({
      text: "I will inspect.",
    });
  });
  it("retains a Plan per Run without putting display data in any model input", () => {
    let state = createHelarcRunPresentation();
    state = appendHelarcRunPresentation(
      state,
      record(1, {
        kind: "state_transition",
        transition: "plan",
        plan: { steps: ["root"] },
      }),
    );
    state = appendHelarcRunPresentation(
      state,
      record(
        1,
        {
          kind: "state_transition",
          transition: "plan",
          plan: { steps: ["child"] },
        },
        "child",
      ),
    );
    expect(state.plans).toEqual({
      root: { steps: ["root"] },
      child: { steps: ["child"] },
    });
  });
  it("bounds Unicode text and structured data, omits known credentials and reports retention", () => {
    expect(boundedPresentationText("a\u4e2db", 3)).toEqual({
      text: "a",
      omittedBytes: 4,
    });
    expect(
      projectHelarcPresentationValue({ apiKey: "secret", input: "read" }),
    ).toEqual({ input: "read" });
    expect(
      JSON.stringify(
        projectHelarcPresentationValue({ value: "a".repeat(100000) }),
      ).length,
    ).toBeLessThan(34000);
    let state = createHelarcRunPresentation();
    for (let i = 1; i <= 18; i++)
      state = appendHelarcRunPresentation(
        state,
        record(i, {
          kind: "controller_turn",
          modelItems: [
            {
              kind: "assistant_text",
              id: `text${i}`,
              turnId: `turn${i}`,
              contentBlockOrdinal: 0,
              text: "a".repeat(300000),
            },
          ],
        }),
      );
    expect(state.retainedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(state.omittedRecords).toBeGreaterThan(0);
  });
});
