import { describe, expect, it } from "vitest";
import type { RunTranscriptRecord } from "@agent-anything/agent-runtime/transcript";
import {
  appendHelarcRunPresentation,
  associateHelarcOperationPresentation,
  createHelarcRunPresentation,
  labelHelarcRunPresentation,
} from "./HelarcRunPresentation.js";
import type { RuntimeEvent } from "@agent-anything/observability";
import {
  createHelarcProductRunProjection as createProjection,
  reduceHelarcProductRunProjection,
  type HelarcProductRunProjection,
  type HelarcProductRunProjectionUpdate,
} from "../HelarcRunProjection.js";

function createHelarcProductRunProjection(runId: string) {
  return createProjection(runId, {
    providerKind: "openai-compatible",
    modelId: "test-model",
    modelIdentityStrength: "unknown",
    status: "experimental",
    policy: "allow_experimental",
    experimentalUseSelected: true,
    scopes: [
      {
        scope: "agent_loop",
        applicability: "absent",
        outcome: null,
        decidedAt: null,
        limitations: [],
      },
    ],
    reasons: ["scope_absent:agent_loop"],
    toolGuidance: {
      releaseId: "test-guidance",
      releaseRevision: `sha256:${"0".repeat(64)}`,
      profileRevision: "test-profile.v1",
    },
  });
}

function record(sequence: number, payload: unknown): RunTranscriptRecord {
  return {
    runId: "root",
    sequence,
    item: {
      ref: { id: `item-${sequence}` },
      committedInRevision: sequence,
      createdAt: "2026-09-29T00:00:00Z",
      payload,
    },
  } as RunTranscriptRecord;
}
function apply(
  current: HelarcProductRunProjection,
  update: Omit<HelarcProductRunProjectionUpdate, "runId" | "sequence">,
) {
  const result = reduceHelarcProductRunProjection(current, {
    ...update,
    runId: current.runId,
    sequence: current.sequence + 1,
  } as HelarcProductRunProjectionUpdate);
  if (result.status !== "applied") throw Error(result.code);
  return result.projection;
}
const turn = record(1, {
  kind: "controller_turn",
  modelItems: [
    {
      kind: "assistant_text",
      id: "text",
      turnId: "turn",
      contentBlockOrdinal: 0,
      text: "Checking",
    },
    {
      kind: "model_tool_call",
      id: "call-item",
      call: {
        name: "Shell",
        input: { command: "echo test" },
        modelCallRef: { id: "call", turnId: "turn", contentBlockOrdinal: 1 },
      },
    },
  ],
});
const action = record(2, {
  kind: "run_action",
  action: {
    ref: { id: "action" },
    provenance: { kind: "controller", modelCallRef: { id: "call" } },
    subject: { kind: "operation", invocationId: "invocation" },
  },
});
const command = {
  runId: "root",
  executionId: "execution",
  revision: 1,
  phase: "running",
  processId: 123,
  outcome: null,
  capturedBytes: 0,
  omittedBytes: 0,
  outputPersistence: "pending",
  observedAt: "2026-09-29T00:00:01Z",
  invocationId: "invocation",
  attemptId: "attempt",
  command: "echo test",
};

describe("Presentation origins", () => {
  it("joins Tool-bound and nested operations through recorded invocation ancestry", () => {
    const toolAction = record(2, {
      kind: "run_action",
      action: {
        ref: { id: "action" },
        provenance: { kind: "controller", modelCallRef: { id: "call" } },
        subject: { kind: "tool", toolCallId: "tool-call" },
      },
    });
    let presentation = appendHelarcRunPresentation(
      appendHelarcRunPresentation(createHelarcRunPresentation(), turn),
      toolAction,
    );
    const event = (
      invocationId: string,
      parentInvocationId: string | null,
      runId = "root",
    ) =>
      ({
        name: "operation.started",
        runId,
        payload: {
          invocationId,
          parentInvocationId,
          parentRunActionId: parentInvocationId ? "inner-action" : "action",
        },
      }) as RuntimeEvent<"operation.started">;
    presentation = associateHelarcOperationPresentation(
      presentation,
      event("outer", null),
    );
    presentation = associateHelarcOperationPresentation(
      presentation,
      event("inner", "outer"),
    );
    const unchanged = associateHelarcOperationPresentation(
      presentation,
      event("foreign", "outer", "other"),
    );
    expect(unchanged).toBe(presentation);
    expect(presentation.activeCalls[0]?.content).toMatchObject({
      invocationId: "outer",
      invocationIds: ["outer", "inner"],
    });
    let p = apply(createHelarcProductRunProjection("product"), {
      kind: "command_observed",
      command: { ...command, invocationId: "inner" },
    } as HelarcProductRunProjectionUpdate);
    p = apply(p, {
      kind: "presentation_observed",
      presentation,
    } as HelarcProductRunProjectionUpdate);
    expect(p.commands[0]?.origin?.modelItemId).toBe("call-item");
  });
  it.each([true, false])(
    "correlates commands regardless of arrival order (command first: %s)",
    (first) => {
      let p = createHelarcProductRunProjection("product");
      let presentation = appendHelarcRunPresentation(
        createHelarcRunPresentation(),
        turn,
      );
      if (first)
        p = apply(p, {
          kind: "command_observed",
          command,
        } as HelarcProductRunProjectionUpdate);
      presentation = appendHelarcRunPresentation(presentation, action);
      p = apply(p, {
        kind: "presentation_observed",
        presentation,
      } as HelarcProductRunProjectionUpdate);
      if (!first)
        p = apply(p, {
          kind: "command_observed",
          command,
        } as HelarcProductRunProjectionUpdate);
      expect(p.commands[0]?.origin).toEqual({
        runId: "root",
        turnId: "turn",
        turnSequence: 1,
        modelItemId: "call-item",
        ordinal: 1,
        callId: "call",
        source: { id: "item-1", sequence: 1 },
      });
      expect(p.presentation.records.map((r) => r.origin?.turnSequence)).toEqual(
        [1, 1],
      );
      p = apply(p, {
        kind: "presentation_observed",
        presentation: {
          ...presentation,
          revision: 9,
          records: [],
          activeCalls: [],
          omittedRecords: 2,
        },
      } as HelarcProductRunProjectionUpdate);
      p = apply(p, {
        kind: "command_observed",
        command: { ...command, revision: 2, phase: "settled" },
      } as HelarcProductRunProjectionUpdate);
      expect(
        JSON.parse(JSON.stringify(p)).commands[0].origin.turnSequence,
      ).toBe(1);
      expect(p.commands[0]?.origin?.modelItemId).toBe("call-item");
    },
  );
  it("does not correlate equal command text across Runs or invocations", () => {
    const presentation = appendHelarcRunPresentation(
      appendHelarcRunPresentation(createHelarcRunPresentation(), turn),
      action,
    );
    let p = apply(createHelarcProductRunProjection("product"), {
      kind: "presentation_observed",
      presentation,
    } as HelarcProductRunProjectionUpdate);
    p = apply(p, {
      kind: "command_observed",
      command: { ...command, runId: "other" },
    } as HelarcProductRunProjectionUpdate);
    p = apply(p, {
      kind: "command_observed",
      command: {
        ...command,
        executionId: "other-execution",
        invocationId: "other",
      },
    } as HelarcProductRunProjectionUpdate);
    expect(p.commands.map((c) => c.origin)).toEqual([null, null]);
  });
  it("keeps separate attempts associated with one call", () => {
    const presentation = appendHelarcRunPresentation(
      appendHelarcRunPresentation(createHelarcRunPresentation(), turn),
      action,
    );
    let p = apply(createHelarcProductRunProjection("product"), {
      kind: "presentation_observed",
      presentation,
    } as HelarcProductRunProjectionUpdate);
    p = apply(p, {
      kind: "command_observed",
      command,
    } as HelarcProductRunProjectionUpdate);
    p = apply(p, {
      kind: "command_observed",
      command: { ...command, executionId: "second", attemptId: "attempt-2" },
    } as HelarcProductRunProjectionUpdate);
    expect(p.commands.map((c) => c.executionId)).toEqual([
      "execution",
      "second",
    ]);
    expect(p.commands.map((c) => c.origin?.callId)).toEqual(["call", "call"]);
    p = apply(p, {
      kind: "command_observed",
      command: { ...command, revision: 2, phase: "settled" },
    } as HelarcProductRunProjectionUpdate);
    expect(p.commands.map((c) => c.executionId)).toEqual([
      "execution",
      "second",
    ]);
    expect(
      reduceHelarcProductRunProjection(p, {
        kind: "command_observed",
        runId: p.runId,
        sequence: p.sequence + 1,
        command: { ...command, revision: 3, invocationId: "different" },
      }),
    ).toMatchObject({ status: "rejected" });
  });
  it("resolves a Child parent origin when the action arrives after its label", () => {
    let p = appendHelarcRunPresentation(createHelarcRunPresentation(), turn);
    p = labelHelarcRunPresentation(
      p,
      "child",
      {
        kind: "descendant",
        root: { id: "root" },
        parent: { id: "root" },
        parentRunAction: { id: "action", run: { id: "root" }, sequence: 1 },
        relation: { id: "relation" },
        depth: 1,
      },
      "task",
    );
    expect(p.labels[0]?.parentOrigin).toBeNull();
    p = appendHelarcRunPresentation(p, action);
    expect(p.labels[0]?.parentOrigin?.modelItemId).toBe("call-item");
    const retained = p.labels[0]?.parentOrigin;
    for (let i = 3; i < 24; i++)
      p = appendHelarcRunPresentation(
        p,
        record(i, {
          kind: "controller_turn",
          modelItems: [
            {
              kind: "assistant_text",
              id: `large-${i}`,
              turnId: `turn-${i}`,
              contentBlockOrdinal: 0,
              text: "x".repeat(256 * 1024),
            },
          ],
        }),
      );
    expect(p.omittedRecords).toBeGreaterThan(0);
    expect(p.records.some((r) => r.id === "text")).toBe(false);
    expect(p.labels[0]?.parentOrigin).toEqual(retained);
    expect(p.activeCalls[0]?.origin?.turnSequence).toBe(1);
  });
});
