import { describe, expect, it } from "vitest";
import type { RunTranscriptRecord } from "@agent-anything/agent-runtime/transcript";
import {
  appendHelarcRunPresentation,
  boundedPresentationText,
  createHelarcRunPresentation,
  labelHelarcRunPresentation,
  projectHelarcPresentationValue,
  helarcSubtaskName,
  receiveHelarcRunInputPresentation,
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
  it("records actual delegated input once without label truncation or system material", () => {
    const text = "Task detail ".repeat(3000);
    let state = labelHelarcRunPresentation(createHelarcRunPresentation(), "child", {
      kind: "descendant", root: {id: "root"}, parent: {id: "root"}, depth: 1,
      parentRunAction: {id: "create", run: {id: "root"}, sequence: 1}, relation: {id: "relation"},
    }, "Not the child's task");
    const input = {task: {id: "task", kind: "helarc.delegated-code-task", input: {prompt: text}, createdAt: at, metadata: {}},
      items: [
        {id: "objective", kind: "message" as const, role: "user" as const, content: text, createdAt: at, metadata: {source: "delegation_objective"}},
        {id: "extra", kind: "message" as const, role: "user" as const, content: "Additional material", createdAt: at, metadata: {}},
        {id: "system", kind: "message" as const, role: "system" as const, content: "PRIVATE instructions", createdAt: at, metadata: {}},
      ], metadata: {private: "not displayed"}};
    state = receiveHelarcRunInputPresentation(state, "child", input, at);
    expect(state.records.map(r => r.content)).toEqual([
      {kind: "received_input", inputKind: "task", text, omittedBytes: 0, senderRunId: "root", disposition: null},
      {kind: "received_input", inputKind: "message", text: "Additional material", omittedBytes: 0, senderRunId: "root", disposition: null},
    ]);
    expect(state.records[0]?.source).toMatchObject({kind: "run_input", id: "child:input"});
    expect(receiveHelarcRunInputPresentation(state, "child", input, at)).toBe(state);
    expect(receiveHelarcRunInputPresentation(state, "root", input, at)).toBe(state);
    state = appendHelarcRunPresentation(state, record(1, {kind: "controller_turn", modelItems: [
      {kind: "assistant_text", id: "reply", turnId: "turn", contentBlockOrdinal: 0, text: "Reply"},
    ]}, "child"));
    expect(state.records.at(-1)?.origin?.turnSequence).toBeGreaterThan(state.records[1]!.sequence);
    expect(JSON.stringify(state.records)).not.toContain("PRIVATE");
  });
  it("keeps a continuation's accepted message separate from its original task", () => {
    const prompt = "Continue with this input. ".repeat(2000);
    let state = appendHelarcRunPresentation(createHelarcRunPresentation(), record(1, {kind: "controller_turn", modelItems: [{
      ...call, metadata: {helarcCallableBinding: {kind: "tool", toolName: "SendMessage", binding: {kind: "descendant_message"}}},
      call: {...call.call, input: {agent_id: "previous", prompt}},
    }]}));
    state = appendHelarcRunPresentation(state, record(2, {kind: "run_action", action: {ref: {id: "continue"},
      provenance: {kind: "controller", modelCallRef: {id: "call"}}, subject: {kind: "tool"}}}));
    state = labelHelarcRunPresentation(state, "continued", {kind: "descendant", root: {id: "root"}, parent: {id: "root"}, depth: 1,
      parentRunAction: {id: "continue", run: {id: "root"}, sequence: 1}, relation: {id: "relation"}}, "Root objective");
    state = receiveHelarcRunInputPresentation(state, "continued", {task: {id: "task", kind: "helarc.delegated-code-task",
      input: {prompt: "Original task"}, createdAt: at, metadata: {}}, items: [], metadata: {}}, at);
    expect(state.records.filter(r => r.runId === "continued").map(r => r.content)).toMatchObject([
      {inputKind: "task", text: "Original task"}, {inputKind: "message", text: prompt},
    ]);
  });
  it("records asynchronous delivered results but does not duplicate ordinary Tool results", () => {
    let state = appendHelarcRunPresentation(createHelarcRunPresentation(), record(1, {kind: "observation", observation: {
      payload: {kind: "descendant_run", output: {summary: "Ordinary Tool return"}},
    }}, "child"));
    expect(state.records).toEqual([]);
    state = appendHelarcRunPresentation(state, record(2, {kind: "observation", observation: {
      payload: {kind: "descendant_result_transfer", childRunId: "nested", status: "partial", output: {summary: "Actual delivered text", secret: "PRIVATE"}},
    }}, "child"));
    expect(state.records[0]?.content).toEqual({kind: "received_input", inputKind: "agent_result", text: "Actual delivered text",
      omittedBytes: 0, senderRunId: "nested", disposition: "partial"});
    expect(JSON.stringify(state.records)).not.toContain("PRIVATE");
  });
  it("retains sibling numbers through reordered labels, completion, and persisted reload", () => {
    let state = labelHelarcRunPresentation(createHelarcRunPresentation(), "root", {kind: "root", root: {id: "root"}, depth: 0}, "Task");
    const add = (id: string, parent = "root") => {
      state = labelHelarcRunPresentation(state, id, {
        kind: "descendant", root: {id: "root"}, parent: {id: parent}, depth: parent === "root" ? 1 : 2,
        parentRunAction: {id: `create-${id}`, run: {id: parent}, sequence: 1}, relation: {id: `relation-${id}`},
      }, "Task");
    };
    add("a"); add("b"); add("nested", "a");
    expect(["a", "b", "nested"].map(id => helarcSubtaskName(state.labels, id))).toEqual(["Subtask 1", "Subtask 2", "Subtask 1.1"]);
    state = {...state, labels: [...state.labels].reverse(), records: [], activeCalls: []};
    add("a");
    state = JSON.parse(JSON.stringify(state));
    add("c"); add("next-nested", "a");
    expect(["a", "b", "c", "nested", "next-nested"].map(id => helarcSubtaskName(state.labels, id)))
      .toEqual(["Subtask 1", "Subtask 2", "Subtask 3", "Subtask 1.1", "Subtask 1.2"]);
    expect(helarcSubtaskName(state.labels, "root")).toBe("Main task");
  });
  it("does not invent a path when ancestors are not yet available", () => {
    const child = labelHelarcRunPresentation(createHelarcRunPresentation(), "child", {
      kind: "descendant", root: {id: "root"}, parent: {id: "root"}, depth: 1,
      parentRunAction: {id: "create", run: {id: "root"}, sequence: 1}, relation: {id: "relation"},
    }, "Task");
    expect(helarcSubtaskName(child.labels, "child")).toBe("Subtask");
    const labeled = labelHelarcRunPresentation(child, "root", {kind: "root", root: {id: "root"}, depth: 0}, "Task");
    expect(helarcSubtaskName(labeled.labels, "child")).toBe("Subtask 1");
    expect(labeled.labels.find(label => label.runId === "child")).toBe(child.labels[0]);
    expect(helarcSubtaskName([{...child.labels[0]!, parentRunId: "child"}], "child")).toBe("Subtask");
  });
  it.each(["completed", "failed", "cancelled"])("retains final candidates separately from commentary until %s terminalization", terminal => {
    let state = appendHelarcRunPresentation(createHelarcRunPresentation(), record(1, {
      kind: "controller_turn", modelItems: [
        { kind: "assistant_text", id: "commentary", turnId: "turn", text: "Same words", contentBlockOrdinal: 0 },
        { ...call, id: "final", metadata: { helarcCallableBinding: { kind: "control", control: "final_result" } },
          call: { ...call.call, modelCallRef: { id: "final", turnId: "turn" }, input: { response: "Same words" } } },
      ],
    }));
    expect(state.records.map(r => r.content.kind)).toEqual(["assistant_text", "final_response"]);
    expect(state.activeCalls).toEqual([]);
    expect(state.records[1]?.content).toMatchObject({ disposition: "proposed", text: "Same words" });
    state = appendHelarcRunPresentation(state, record(2, { kind: "model_call_settlement",
      result: { modelCallRef: { id: "final" }, settlement: "succeeded", content: {} } }));
    expect(state.records[1]?.content).toMatchObject({ disposition: "accepted" });
    state = appendHelarcRunPresentation(state, record(3, { kind: "terminal_transition", status: terminal,
      cause: { kind: "normal", code: "completed", source: "runtime", underlying: [], recordedAt: at }, settlement: { completedAt: at } }));
    expect(state.records[1]?.content).toMatchObject({ disposition: terminal });
    expect(state.records[0]?.content).toMatchObject({ kind: "assistant_text", text: "Same words" });
  });
  it("keeps a declined final distinct from a later accepted candidate", () => {
    let state = appendHelarcRunPresentation(createHelarcRunPresentation(), record(1, {
      kind: "controller_turn", modelItems: [{ ...call, metadata: { helarcCallableBinding: { kind: "control", control: "final_result" } },
        call: { ...call.call, input: { response: "" } } }],
    }));
    state = appendHelarcRunPresentation(state, record(2, { kind: "model_call_settlement",
      result: { modelCallRef: { id: "call" }, settlement: "invalidated", content: {} } }));
    state = appendHelarcRunPresentation(state, record(3, { kind: "terminal_transition", status: "completed",
      cause: { kind: "normal", code: "completed", source: "runtime", underlying: [], recordedAt: at }, settlement: { completedAt: at } }));
    expect(state.records[0]?.content).toMatchObject({ kind: "final_response", text: "", disposition: "declined" });
  });
  it("retains Tool binding kind and interaction protocol without changing callable semantics", () => {
    const protocol = { owner: "helarc", kind: "clarification", revision: "1" };
    const bindings = [
      { kind: "tool", toolName: "Ask", binding: { kind: "interaction", protocol } },
      { kind: "tool", toolName: "AskUserQuestion", binding: { kind: "operation" } },
      { kind: "tool", toolName: "Agent", binding: { kind: "descendant_agent" } },
      { kind: "tool", toolName: "SendMessage", binding: { kind: "descendant_message" } },
      { kind: "tool", toolName: "Unknown", binding: { kind: "unknown" } },
    ];
    const state = appendHelarcRunPresentation(createHelarcRunPresentation(), record(1, {
      kind: "controller_turn", modelItems: bindings.map((binding, i) => ({
        ...call, id: `call-${i}`, metadata: { helarcCallableBinding: binding },
        call: { ...call.call, name: `callable-${i}`, modelCallRef: { id: `call-${i}`, turnId: "turn" } },
      })),
    }));
    expect(state.records.map(r => r.content)).toMatchObject([
      { callableKind: "tool", toolBindingKind: "interaction", interactionProtocol: protocol },
      { callableKind: "tool", toolBindingKind: "operation", interactionProtocol: null },
      { callableKind: "tool", toolBindingKind: "descendant_agent", interactionProtocol: null },
      { callableKind: "tool", toolBindingKind: "descendant_message", interactionProtocol: null },
      { callableKind: "tool", toolBindingKind: null, interactionProtocol: null },
    ]);
  });
  it("records the resolved binding without interpreting a model-callable name", () => {
    const state = appendHelarcRunPresentation(createHelarcRunPresentation(), record(1, {
      kind: "controller_turn", modelItems: [
        { ...call, metadata: { helarcCallableBinding: { kind: "tool", toolName: "Agent" } },
          call: { ...call.call, name: "Agent_abc123" } },
        { ...call, id: "unknown", call: { ...call.call, name: "Agent_not_registered" } },
        { ...call, id: "plan", metadata: { helarcCallableBinding: { kind: "control", control: "update_plan" } },
          call: { ...call.call, modelCallRef: { id: "plan", turnId: "turn" }, name: "plan_alias" } },
        { ...call, id: "named-tool", metadata: { helarcCallableBinding: { kind: "tool", toolName: "update_plan" } },
          call: { ...call.call, name: "update_plan" } },
        { ...call, id: "missing-binding", call: { ...call.call, name: "update_plan" } },
        { ...call, id: "invalid-binding", metadata: { helarcCallableBinding: { kind: "control" } } },
      ],
    }));
    expect(state.records.map(r => r.content)).toMatchObject([
      { name: "Agent_abc123", callableKind: "tool", resolvedName: "Agent" },
      { name: "Agent_not_registered", callableKind: "unresolved", resolvedName: null },
      { name: "plan_alias", callableKind: "control", resolvedName: "update_plan" },
      { name: "update_plan", callableKind: "tool", resolvedName: "update_plan" },
      { name: "update_plan", callableKind: "unresolved", resolvedName: null },
      { name: "Agent", callableKind: "unresolved", resolvedName: null },
    ]);
    const settled = appendHelarcRunPresentation(state, record(2, {
      kind: "model_call_settlement", result: { modelCallRef: { id: "plan" }, settlement: "succeeded", content: { kind: "plan_update" } },
    }));
    expect(settled.records.find(r => r.id === "plan")?.content).toMatchObject({
      callableKind: "control", resolvedName: "update_plan", settlement: "succeeded",
    });
    expect(settled.activeCalls.some(r => r.id === "plan")).toBe(false);
  });
  it("keeps active calls independently from history retention and settles them by exact call identity",()=>{
    let state=appendHelarcRunPresentation(createHelarcRunPresentation(),record(1,{kind:"controller_turn",modelItems:[call]}));
    state={...state,records:[],retainedBytes:0,omittedRecords:1};
    expect(state.activeCalls).toHaveLength(1);
    state=appendHelarcRunPresentation(state,record(2,{kind:"run_action",action:{ref:{id:"action"},
      provenance:{kind:"controller",modelCallRef:{id:"call"}},subject:{kind:"operation",invocationId:"invocation"}}}));
    expect(state.activeCalls[0]?.content).toMatchObject({runActionId:"action",invocationId:"invocation"});
    state=appendHelarcRunPresentation(state,record(3,{kind:"model_call_settlement",result:{modelCallRef:{id:"call"},settlement:"succeeded",content:"done"}}));
    expect(state.activeCalls).toEqual([]);expect(state.records[0]?.content).toMatchObject({settlement:"succeeded"});
  });
  it("records applied user steering and typed retry waits without impersonating other origins",()=>{
    let state=appendHelarcRunPresentation(createHelarcRunPresentation(),record(1,{kind:"state_transition",transition:"steering",
      steering:{status:"applied",command:{commandId:"steer-1",instruction:"Read only",attribution:{origin:"user"}}}}));
    state=appendHelarcRunPresentation(state,record(2,{kind:"state_transition",transition:"steering",
      steering:{status:"cancelled",command:{commandId:"steer-2",instruction:"Host change",attribution:{origin:"host"}}}}));
    state=appendHelarcRunPresentation(state,record(3,{kind:"retry_transition",transition:"ready",pending:{kind:"retry_wait"}}));
    expect(state.records.map(r=>r.content)).toMatchObject([{kind:"steering",origin:"user",disposition:"applied"},
      {kind:"steering",origin:"host",disposition:"cancelled"},{kind:"interaction",title:"retry_wait: ready"}]);
  });
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
