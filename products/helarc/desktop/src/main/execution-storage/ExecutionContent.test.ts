import {describe, expect, it} from "vitest";
import {canonicalEncode} from "@agent-anything/canonical-action/subject";
import {packExecutionContent, unpackExecutionContent, executionContentReferences, EXECUTION_CONTENT_LIMITS, type ExecutionContentBlock} from "./ExecutionContent.js";

function roundTrip(value: unknown) {
  const packed = packExecutionContent(value);
  const blocks = new Map(packed.blocks.map(block => [block.id, block]));
  for (const block of packed.blocks) {
    expect(Buffer.byteLength(block.text)).toBeLessThanOrEqual(EXECUTION_CONTENT_LIMITS.blockBytes);
    for (const ref of executionContentReferences(block)) expect(blocks.has(ref)).toBe(true);
  }
  return unpackExecutionContent(packed, id => blocks.get(id)!);
}

describe("execution content", () => {
  it("round-trips history beyond the canonical Action node limit without changing that limit", () => {
    const history = Array.from({length: 30000}, (_, index) => ({id: `item-${index}`, sequence: index, result: {text: "done", delivery: index}}));
    expect(() => canonicalEncode("test.action.v1", history)).toThrow("100000 nodes");
    expect(roundTrip({history, checkpoints: [["provider-response", {revision: 1, value: history}]]})).toEqual({history, checkpoints: [["provider-response", {revision: 1, value: history}]]});
  }, 20000);

  it("shares identical content without conflating stage identities and preserves ordered append prefixes", () => {
    const first = packExecutionContent({history: Array.from({length: 96}, (_, id) => ({id})), checkpoints: [["native", {messages: ["same"]}], ["assessed", {messages: ["same"]}]]});
    const next = packExecutionContent({history: Array.from({length: 97}, (_, id) => ({id})), checkpoints: [["native", {messages: ["same"]}], ["assessed", {messages: ["same"]}]]});
    const known = new Set(first.blocks.map(block => block.id));
    expect(next.blocks.filter(block => !known.has(block.id)).length).toBeLessThan(10);
    expect(roundTrip({a: {array: "a".repeat(64)}, b: "ref", c: "\ud800".repeat(10000)})).toEqual({a: {array: "a".repeat(64)}, b: "ref", c: "\ud800".repeat(10000)});
  });

  it("preserves nested object member order used by retained request/fingerprint material", () => {
    const input = {z: 1, a: {z: "last", a: "first"}, calls: [{name: "Read", arguments: {z: "path", a: "value"}}]};
    expect(JSON.stringify(roundTrip(input))).toBe(JSON.stringify(input));
  });

  it.each(([undefined, NaN, Infinity, new Date(), () => 1, [1, , 3], {constructor: "no"}, {prototype: "no"}] as unknown[]).map(value => ({value})))("rejects unsafe checkpoint values ($value)", ({value}) => {
    expect(() => packExecutionContent(value)).toThrow();
  });
  it("never calls getters, accepts cycles, ignores symbols or loses hidden properties", () => {
    let invoked = false;
    expect(() => packExecutionContent({get value() {invoked = true; return 1;}})).toThrow();
    expect(invoked).toBe(false);
    const cycle: unknown[] = []; cycle.push(cycle);
    expect(() => packExecutionContent(cycle)).toThrow();
    expect(() => packExecutionContent({[Symbol("hidden")]: 1})).toThrow();
    expect(() => packExecutionContent(Object.defineProperty({}, "hidden", {value: 1}))).toThrow();
  });
  it("fails on missing or corrupt retained content, not an empty result", () => {
    const packed = packExecutionContent({items: ["one", "two"]});
    const blocks = new Map(packed.blocks.map(block => [block.id, block]));
    expect(() => unpackExecutionContent(packed, () => undefined as unknown as ExecutionContentBlock)).toThrow("execution_content_missing");
    expect(() => unpackExecutionContent(packed, id => ({...blocks.get(id)!, text: '["value",null]'}))).toThrow("execution_content_corrupt");
  });
});
