import {describe, expect, it} from "vitest";
import {canonicalEncode} from "@agent-anything/canonical-action/subject";
import {contentDigest, packExecutionContent, unpackExecutionContent, executionContentReferences, ExecutionContentCache, ExecutionContentEncoder, ExecutionContentScope, ExecutionContentStatistics, snapshotEncodedExecutionContent, EXECUTION_CONTENT_LIMITS, type ExecutionContentBlock} from "./ExecutionContent.js";

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
  const immutable = <T>(value: T): T => {packExecutionContent(value); return snapshotEncodedExecutionContent(value);};
  it("reuses a verified immutable container even when its large leaf strings are already cached",()=>{
    const statistics=new ExecutionContentStatistics(true),encoder=new ExecutionContentEncoder(undefined,statistics);
    const history=immutable(Array.from({length:48},(_,index)=>({index,content:`entry ${index} `.repeat(700),metadata:{owner:"model",revision:"1"}})));
    const expected=packExecutionContent({history});
    expect(encoder.pack({history})).toEqual(expected);statistics.take();
    expect(encoder.pack({history})).toEqual(expected);
    expect(statistics.take()["encode.nodes"]).toBeLessThan(10);
  });
  it("shares large representations only within the command and preserves encoding order and accounting", () => {
    const stats = new ExecutionContentStatistics(true), encoder = new ExecutionContentEncoder(0, stats);
    const scope = new ExecutionContentScope();
    const history = immutable(Array.from({length: 1000}, (_, i) => ({i, text: `entry ${i} `.repeat(70)})));
    encoder.pack({prefix: history[0]!.text, history}, scope);
    stats.take();
    const wrapped = {kind: "run", value: history, again: history};
    expect(encoder.pack(wrapped, scope)).toEqual(packExecutionContent(wrapped));
    const reused = stats.take();
    expect(reused["encode.reusedBytes"]).toBeGreaterThan(512 * 1024);
    expect(reused["encode.nodes"]).toBeLessThan(10);
    expect(encoder.pack(wrapped, new ExecutionContentScope())).toEqual(packExecutionContent(wrapped));
    expect(stats.take()["encode.nodes"]).toBeGreaterThan(1000);
    let deep: unknown = history;
    for (let n = 0; n < 64; n++) deep = [deep];
    expect(() => encoder.pack(deep, scope)).toThrow("execution_content_depth_exceeded");
    expect(() => encoder.pack(Array.from({length: 256}, () => history), scope)).toThrow("execution_content_capacity_exceeded");
  });
  it("shares decoded command nodes but checks current bytes, mutable output and resource bounds", () => {
    const scope = new ExecutionContentScope(), stats = new ExecutionContentStatistics(true);
    const cache = new ExecutionContentCache(0, 0, stats);
    const packed = packExecutionContent({text: "large result ".repeat(50000)});
    const blocks = new Map(packed.blocks.map(block => [block.id, block]));
    const read = (id: string) => blocks.get(id)!;
    const first = unpackExecutionContent(packed, read, cache, true, scope);
    stats.take();
    expect(unpackExecutionContent(packed, read, cache, true, scope)).toBe(first);
    expect(stats.take()["decode.reusedBytes"]).toBeGreaterThan(512 * 1024);
    expect(unpackExecutionContent(packed, read, cache, true, new ExecutionContentScope())).not.toBe(first);
    expect(unpackExecutionContent(packed, read, cache, false, scope)).not.toBe(first);
    for (const [count, repeat, error] of [[65, false, "execution_content_depth_exceeded"], [9, true, "execution_content_capacity_exceeded"]] as const) {
      let root = packed.root;
      for (let n = 0; n < count; n++) {
        const ref = ["ref", root], text = JSON.stringify(["value", ["items", repeat ? [ref, ref] : [ref]]]);
        root = contentDigest(text); blocks.set(root, {id: root, text});
      }
      expect(() => unpackExecutionContent({format: 1, root}, read, cache, true, scope)).toThrow(error);
    }
    const leaf = packed.blocks.find(block => block.text.startsWith('["string_page"'))!;
    blocks.set(leaf.id, {...leaf, text: '["string_page",["changed"]]'});
    expect(() => unpackExecutionContent(packed, read, cache, true, scope)).toThrow("execution_content_corrupt");
    blocks.delete(leaf.id);
    expect(() => unpackExecutionContent(packed, read, cache, true, scope)).toThrow("execution_content_missing");
  });
  it("does not retain mutable values in a command encoding scope", () => {
    const scope = new ExecutionContentScope(), encoder = new ExecutionContentEncoder(0);
    const child = {text: "first"}, value = Object.freeze({child});
    const first = encoder.pack(value, scope);
    child.text = "second";
    expect(encoder.pack(value, scope).root).not.toBe(first.root);
    expect(encoder.pack(value, scope)).toEqual(packExecutionContent(value));
    expect(() => encoder.pack(Object.freeze({constructor: "unsafe"}), scope)).toThrow("execution_content_value_invalid");
  });
  it("reuses verified immutable encodings without changing roots, blocks or expanded accounting", () => {
    const encoder = new ExecutionContentEncoder();
    const history = immutable(Array.from({length: 80}, (_, i) => ({i, text: `message ${i} `.repeat(300)})));
    for (const value of [{history}, {revision: 2, history, again: history}, {history, summary: "done"}]) {
      const expected = packExecutionContent(value);
      expect(encoder.pack(value)).toEqual(expected);
      expect(encoder.pack(value)).toEqual(expected);
    }
    encoder.clear();
    expect(encoder.pack({history})).toEqual(packExecutionContent({history}));
    const exposed = encoder.pack({history}).blocks.find(block => block.text.startsWith('["string_page"'))!;
    expect(() => {(exposed as {text: string}).text = "changed";}).toThrow();
    expect(encoder.pack({history})).toEqual(packExecutionContent({history}));
  });
  it("does not treat shallow freezing as immutable ownership", () => {
    const encoder = new ExecutionContentEncoder();
    const child = {text: "original".repeat(2000)};
    const root = Object.freeze({child});
    const before = encoder.pack(root);
    child.text = "changed".repeat(2000);
    expect(encoder.pack(root)).toEqual(packExecutionContent(root));
    expect(encoder.pack(root).root).not.toBe(before.root);
  });
  it("reuses only codec-validated frozen shapes and keeps exact source order and charges", () => {
    const value = Object.freeze({z: Object.freeze([true, -0, null]), a: Object.freeze({z: 2, a: 1})});
    const expected = packExecutionContent(JSON.parse(JSON.stringify(value)));
    expect(packExecutionContent(value)).toEqual(expected);
    expect(packExecutionContent(value)).toEqual(expected);
    // Even the snapshot helper is not a substitute for codec validation.
    const unsafe = snapshotEncodedExecutionContent({constructor: "forbidden"});
    expect(() => packExecutionContent(unsafe)).toThrow("execution_content_value_invalid");
    const invalid = Object.freeze(Object.defineProperty({}, "hidden", {value: 1}));
    expect(() => packExecutionContent(invalid)).toThrow("execution_content_value_invalid");
    let deep: unknown = value;
    for (let n = 0; n < 64; n++) deep = Object.freeze([deep]);
    expect(() => packExecutionContent([value, deep])).toThrow("execution_content_depth_exceeded");
  });
  it("shares large immutable references within one expansion without retaining them across calls", () => {
    const payload = {text: "large result ".repeat(50000)};
    const packed = packExecutionContent({first: payload, second: payload});
    const blocks = new Map(packed.blocks.map(block => [block.id, block]));
    const cache = new ExecutionContentCache(0, 0), read = (id: string) => blocks.get(id)!;
    const first = unpackExecutionContent(packed, read, cache, true) as {first: typeof payload; second: typeof payload};
    expect(first.first).toBe(first.second);
    expect(first.first).toEqual(payload);
    expect(Object.isFrozen(first.first)).toBe(true);
    const next = unpackExecutionContent(packed, read, cache, true) as typeof first;
    expect(next.first).not.toBe(first.first);
    const mutable = unpackExecutionContent(packed, read) as typeof first;
    expect(mutable.first).not.toBe(mutable.second);
    const leaf = packed.blocks.find(block => block.text.startsWith('["string_page"'))!;
    blocks.delete(leaf.id);
    expect(() => unpackExecutionContent(packed, read, cache, true)).toThrow("execution_content_missing");
  });
  it("charges aliased expansions with cross-call caching disabled", () => {
    const packed = packExecutionContent({text: "payload".repeat(10000)});
    const blocks = new Map(packed.blocks.map(block => [block.id, block]));
    let root = packed.root;
    for (let n = 0; n < 12; n++) {
      const text = JSON.stringify(["value", ["items", [["ref", root], ["ref", root]]]]);
      root = contentDigest(text); blocks.set(root, {id: root, text});
    }
    expect(() => unpackExecutionContent({format: 1, root}, id => blocks.get(id)!, new ExecutionContentCache(0, 0), true))
      .toThrow("execution_content_capacity_exceeded");
  });
  it("preserves block order when shared content was first encountered outside a cached subtree", () => {
    const encoder = new ExecutionContentEncoder();
    const a = "first ".repeat(400), b = "second ".repeat(400);
    const payload = immutable({b, a});
    encoder.pack({prefix: a, payload});
    expect(encoder.pack(payload)).toEqual(packExecutionContent(payload));
    const long = "long string ".repeat(35000);
    encoder.pack({prefix: long.slice(-10000), long});
    expect(encoder.pack({long})).toEqual(packExecutionContent({long}));
  });
  it("reuses decoded subtrees only after rereading their complete current closure", () => {
    const cache = new ExecutionContentCache();
    const payload = {text: "message".repeat(3000), entries: Array.from({length: 40}, (_, n) => ({n}))};
    const first = packExecutionContent({revision: 1, payload});
    const next = packExecutionContent({revision: 2, payload});
    const blocks = new Map([...first.blocks, ...next.blocks].map(b => [b.id, b]));
    const read = (id: string) => blocks.get(id)!;
    const a = unpackExecutionContent(first, read, cache, true) as {payload: typeof payload};
    const b = unpackExecutionContent(next, read, cache, true) as typeof a;
    expect(b.payload).toBe(a.payload);
    expect(Object.isFrozen(b.payload.entries[0])).toBe(true);
    const leaf = first.blocks.find(b => b.text.startsWith('["string_page"'))!;
    blocks.set(leaf.id, {...leaf, text: '["string_page",["tampered"]]'});
    expect(() => unpackExecutionContent(next, read, cache, true)).toThrow("execution_content_corrupt");
    blocks.delete(leaf.id);
    expect(() => unpackExecutionContent(next, read, cache, true)).toThrow("execution_content_missing");
  });
  it("does not let warm immutable representation reuse hide logical capacity or depth", () => {
    const encoder = new ExecutionContentEncoder();
    const payload = immutable({text: "x".repeat(16000)});
    encoder.pack(payload);
    let deep: unknown = payload;
    for (let i = 0; i < 64; i++) deep = [deep];
    expect(() => encoder.pack(deep)).toThrow("execution_content_depth_exceeded");
    let wide: unknown = payload;
    for (let i = 0; i < 14; i++) wide = [wide, wide];
    expect(() => encoder.pack(wide)).toThrow("execution_content_capacity_exceeded");

    const packed = packExecutionContent({payload});
    const cache = new ExecutionContentCache();
    const blocks = new Map(packed.blocks.map(b => [b.id, b]));
    unpackExecutionContent(packed, id => blocks.get(id)!, cache, true);
    const repeated = packExecutionContent(Array.from({length: 200}, () => payload));
    for (const b of repeated.blocks) blocks.set(b.id, b);
    expect(unpackExecutionContent(repeated, id => blocks.get(id)!, cache, true))
      .toEqual(Array.from({length: 200}, () => payload));
  });
  it("reuses only exact validated bytes, bounds retained entries and never trusts a mutable parsed value", () => {
    const cache = new ExecutionContentCache(1024, 1);
    const a = packExecutionContent({message: "a"}).blocks.at(-1)!;
    const b = packExecutionContent({message: "b"}).blocks.at(-1)!;
    const parsed = cache.parse(a);
    expect(cache.parse({...a})).toBe(parsed);
    expect(() => (parsed as unknown[])[0] = "branch").toThrow();
    expect(() => cache.parse({...a, text: b.text})).toThrow("execution_content_corrupt");
    cache.parse(b);
    expect(cache.parse(a)).not.toBe(parsed);
    const next = cache.parse(a); cache.clear();
    expect(cache.parse(a)).not.toBe(next);
  });
  it("enforces expanded depth and size on warm decoded DAGs and bounds decoded retention", () => {
    const packed = packExecutionContent({text: "payload".repeat(2000)});
    const blocks = new Map(packed.blocks.map(block => [block.id, block]));
    const cache = new ExecutionContentCache(100000, 1);
    const read = (id: string) => blocks.get(id)!;
    const first = unpackExecutionContent(packed, read, cache, true);
    expect(unpackExecutionContent(packed, read, cache, true)).toBe(first);
    cache.clear();
    expect(unpackExecutionContent(packed, read, cache, true)).not.toBe(first);
    for (const [count, repeat, error] of [[65, false, "execution_content_depth_exceeded"],
      [14, true, "execution_content_capacity_exceeded"]] as const) {
      let root = packed.root;
      for (let n = 0; n < count; n++) {
        const ref = ["ref", root];
        const text = JSON.stringify(["value", ["items", repeat ? [ref, ref] : [ref]]]);
        root = contentDigest(text); blocks.set(root, {id: root, text});
      }
      expect(() => unpackExecutionContent({format: 1, root}, read, cache, true)).toThrow(error);
    }
  });

  it("charges every repeated occurrence and checks its depth even when representation work is shared", () => {
    const shared = {z: "payload".repeat(200), a: [1, true]};
    const repeated = [shared, shared];
    expect(packExecutionContent(repeated)).toEqual(packExecutionContent(JSON.parse(JSON.stringify(repeated))));
    let expanded: unknown = shared;
    for (let i = 0; i < 20; i++) expanded = [expanded, expanded];
    expect(() => packExecutionContent(expanded)).toThrow("execution_content_capacity_exceeded");
    let deep: unknown = shared;
    for (let i = 0; i < 64; i++) deep = [deep];
    expect(() => packExecutionContent([shared, deep])).toThrow("execution_content_depth_exceeded");
  });
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
  it("rejects executable proxies before they can mutate an already encoded object", () => {
    const shared = {text: "original"};
    let invoked = false;
    const proxy = new Proxy({}, {ownKeys() {invoked = true; shared.text = "changed"; return [];}});
    expect(() => packExecutionContent([shared, proxy, shared])).toThrow("execution_content_value_invalid");
    expect(invoked).toBe(false);
    expect(shared.text).toBe("original");
  });
  it("fails on missing or corrupt retained content, not an empty result", () => {
    const packed = packExecutionContent({items: ["one", "two"]});
    const blocks = new Map(packed.blocks.map(block => [block.id, block]));
    expect(() => unpackExecutionContent(packed, () => undefined as unknown as ExecutionContentBlock)).toThrow("execution_content_missing");
    expect(() => unpackExecutionContent(packed, id => ({...blocks.get(id)!, text: '["value",null]'}))).toThrow("execution_content_corrupt");
  });
});
