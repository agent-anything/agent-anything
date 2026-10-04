import { describe, expect, it } from "vitest";
import type { HelarcRunProjection } from "@agent-anything/helarc/run";
import { conversationChildResponse } from "./ConversationChildResponse.js";

function fixture() {
  const record = {id: "record", runId: "child", revision: 1, sequence: 1,
    observedAt: "2026-10-01T00:00:00.000Z", origin: {modelItemId: "text"},
    content: {kind: "assistant_text", text: "Earlier public response", omittedBytes: 0}};
  const part = {id: "part", kind: "text", text: "Current public response", receivedLength: 23,
    omittedBytes: 0, modelItemId: null, committedRecordId: null};
  const attempt = {runId: "child", invocationId: "request", state: "receiving",
    observedAt: "2026-10-01T00:00:01.000Z", parts: [part]};
  const p = {product: {presentation: {records: [record]}, responses: {attempts: [attempt]}}} as unknown as HelarcRunProjection;
  return {p, record, part, attempt};
}

describe("Child response excerpts", () => {
  it("uses only this Child's public text, never Tool arguments or another Child", () => {
    const {p, part, attempt} = fixture();
    Object.assign(attempt, {parts: [part, {...part, id: "tool", kind: "tool_call", text: "PRIVATE arguments"}]});
    Object.assign(p.product.responses, {attempts: [attempt, {...attempt, runId: "sibling", parts: [{...part, text: "Other child"}]}]});
    expect(conversationChildResponse(p, "child")?.text).toBe("Current public response");
    expect(conversationChildResponse(p, "unknown")).toBeNull();
  });
  it("bounds the tail, preserves Unicode and discloses upstream omission", () => {
    const {p, part} = fixture();
    Object.assign(part, {text: "x".repeat(1000) + "\ud83d\ude00" + "z".repeat(511), omittedBytes: 64});
    const preview = conversationChildResponse(p, "child")!;
    expect(preview.text.length).toBeLessThanOrEqual(512);
    expect(preview.text).toBe("z".repeat(511));
    expect(preview.retentionLimited).toBe(true);
  });
  it("prefers the exact committed record over its buffered preview", () => {
    const {p, part, record} = fixture();
    Object.assign(part, {committedRecordId: "record"});
    Object.assign(record.content, {kind: "final_response", text: "Final recorded response", disposition: "completed"});
    expect(conversationChildResponse(p, "child")).toMatchObject({text: "Final recorded response", disposition: null});
  });
  it("marks proposed and failed responses without turning them into completed answers", () => {
    const {p, part, attempt} = fixture();
    Object.assign(part, {kind: "final_response"});
    expect(conversationChildResponse(p, "child")?.disposition).toBe("Awaiting completion");
    Object.assign(attempt, {state: "interrupted"});
    expect(conversationChildResponse(p, "child")?.disposition).toBe("interrupted response");
  });
  it("keeps previous text while waiting and does not announce private-only updates", () => {
    const {p, part, attempt} = fixture();
    const previous = conversationChildResponse(p, "child");
    Object.assign(attempt, {revision: 999, parts: [part, {...part, kind: "tool_call", text: "PRIVATE arguments"}]});
    expect(conversationChildResponse(p, "child")?.revision).toBe(previous?.revision);
    Object.assign(attempt, {parts: []});
    expect(conversationChildResponse(p, "child")?.text).toBe("Earlier public response");
  });
});
