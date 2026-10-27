import {describe, expect, it, vi} from "vitest";
import type {RunTranscriptRecord} from "@agent-anything/agent-runtime/transcript";
import type {InspectionRecorder} from "../recording/index.js";
import {RunTranscriptInspectionAdapter} from "./RunInspectionAdapter.js";

describe("execution reference model delivery inspection", () => {
  it.each(["complete", "unavailable"])("links actual %s presentation locators without implying material body delivery", disposition => {
    const offer = vi.fn();
    const recorder = {offer, ref: (owner: string, kind: string, id: string, runId: string, revision: string | null = null) => ({owner, kind, id, runId, revision})};
    const adapter = new RunTranscriptInspectionAdapter(recorder as unknown as InspectionRecorder);
    const sourceRefs = ["execution", "effect", "support", "material", "operation_result"].map(kind => ({owner: "files", kind, id: `${kind}-1`, revision: "2"}));
    adapter.observe({runId: "run", item: {ref: {id: "item-1", sequence: 1}, createdAt: "2026-10-16T00:00:00.000Z",
      payload: {kind: "model_call_settlement", result: {modelCallRef: {id: "call", contentBlockOrdinal: 0},
        sourceRefs, content: {references: sourceRefs, failure: {owner: "permission", code: "interaction_expired", message: "Approval expired before execution."}},
        presentation: {disposition, presenter: {id: "presenter", revision: "2"}, failureCode: null}}}}} as unknown as RunTranscriptRecord);
    const presentation = offer.mock.calls.map(([value]) => value).find(value => value.payload.name === `model_result.presentation.${disposition}`);
    const links = presentation.links.filter((link: {operation: string}) => link.operation === "execution_reference_delivery");
    expect(links).toHaveLength(4);
    expect(links[0]).toMatchObject({kind: "delivers", from: {owner: "files", kind: "contribution", id: "execution:execution-1", revision: "2", runId: "run"},
      to: {id: "call:presentation"}});
    expect(links[3].from.id).toBe("material:material-1");
    expect(JSON.stringify(links)).not.toContain("content_range");
    expect(presentation.links).toContainEqual(expect.objectContaining({kind: "transforms",
      from: expect.objectContaining({id: "operation_result-1"}), operation: "presenter@2"}));
    const result = offer.mock.calls.map(([value]) => value).find(value => value.contents?.[0]?.name === "Model Tool Result");
    expect(result.contents[0].value.content.failure).toEqual({owner: "permission", code: "interaction_expired", message: "Approval expired before execution."});
    expect(result.contents[0].value).toEqual(presentation.contents[0].value);
  });
});
