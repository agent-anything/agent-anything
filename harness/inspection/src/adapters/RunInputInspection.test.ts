import {expect, it, vi} from "vitest";
import type {RunExecutionObservation} from "@agent-anything/agent-runtime/execution-coordinator";
import type {InspectionRecorder} from "../recording/index.js";
import {RunExecutionInspectionAdapter} from "./RunExecutionInspectionAdapter.js";

it("captures admitted input and Parent delegation as sources, not reconstructed presentation text", () => {
  const offer = vi.fn();
  const recorder = {offer, ref: (owner: string, kind: string, id: string, runId: string, revision: string | null = null) => ({owner, kind, id, runId, revision})};
  const item = {id: "objective", kind: "message", role: "user", content: "Inspect without editing.", metadata: {source: "delegation_objective"}};
  const request = {ref: {id: "delegation", revision: "2"}, origin: {parent: {run: {id: "parent"}, action: {id: "parent-action"}}}, objective: {text: item.content}};
  new RunExecutionInspectionAdapter(recorder as unknown as InspectionRecorder).observe({kind: "run_input", runId: "child", occurredAt: null,
    input: {task: {id: "task"}, items: [item]}, configuration: {}, delegationRequest: request} as unknown as RunExecutionObservation);
  const records = offer.mock.calls.map(([value]) => value);
  const inputRecord = records.find(value => value.payload.name === "run_input_item.bound");
  expect(inputRecord.subject).toEqual({owner: "agent-core", kind: "contribution", id: "objective", runId: "child", revision: "1"});
  expect(inputRecord.contents[0].value).toBe(item);
  const delegation = records.find(value => value.payload.name === "delegation_request.bound");
  expect(delegation.subject).toMatchObject({owner: "agent-runtime", id: "delegation", runId: "parent", revision: "2"});
  expect(delegation.contents[0].value).toBe(request);
  expect(delegation.links).toEqual(expect.arrayContaining([
    expect.objectContaining({kind: "produces", from: expect.objectContaining({id: "parent-action", runId: "parent"})}),
    expect.objectContaining({kind: "binding", to: expect.objectContaining({id: "child", runId: "child"})}),
  ]));
});
