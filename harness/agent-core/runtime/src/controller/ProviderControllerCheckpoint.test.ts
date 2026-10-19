import { describe, expect, it, vi } from "vitest";
import { canonicalEncode } from "@agent-anything/canonical-action/subject";
import { ControllerCheckpointError } from "./ControllerCheckpoint.js";
import { ProviderControllerCheckpoint } from "./ProviderControllerCheckpoint.js";

function setup() {
  const records = new Map<string, unknown>();
  const port = {
    read: (key: string) => records.get(key) ?? null,
    commit: vi.fn(async (key: string, value: unknown) => { records.set(key, structuredClone(value)); }),
  };
  return {records, port, checkpoint: new ProviderControllerCheckpoint(port)};
}

describe("Provider Controller checkpoint values", () => {
  it("saves and restores complete history beyond the Action canonical node limit", async () => {
    const {checkpoint, port, records} = setup();
    const value = {history: Array.from({length: 25_000}, (_, sequence) => ({
      sequence, response: {text: "retained", status: "settled"},
    }))};
    expect(() => canonicalEncode("test.controller-checkpoint.v1", value)).toThrowError(
      expect.objectContaining({code: "canonical_encoding_too_large"}),
    );
    await checkpoint.save("response", value);
    expect(records.get("provider-controller:response")).toEqual({revision: 1, value});
    const restored = new ProviderControllerCheckpoint(port);
    expect(restored.read("response")).toEqual(value);
    const create = vi.fn(() => ({history: []}));
    expect(await restored.once("response", create)).toEqual(value);
    expect(create).not.toHaveBeenCalled();
    expect(port.commit).toHaveBeenCalledTimes(1);
    restored.read<typeof value>("response")!.history[0]!.response.text = "changed";
    expect(restored.read("response")).toEqual(value);
  });

  it("accepts finite JSON primitives, frozen containers, null prototypes and shared noncyclic values", async () => {
    const {checkpoint, port} = setup();
    const shared = Object.freeze({text: "retained"});
    const record = Object.assign(Object.create(null), {shared});
    const value = Object.freeze([null, true, false, "", 0, -0, 1.25, Number.MAX_VALUE, record, shared]);
    await checkpoint.save("response", value);
    expect(checkpoint.read("response")).toEqual(structuredClone(value));
    expect(port.commit).toHaveBeenCalledTimes(1);
  });

  const invalidValues: readonly [string, () => unknown][] = [
    ["undefined", () => undefined],
    ["nested undefined", () => ({value: undefined})],
    ["function", () => ({value: () => null})],
    ["symbol value", () => ({value: Symbol("value")})],
    ["bigint", () => ({value: 1n})],
    ["NaN", () => ({value: NaN})],
    ["positive infinity", () => ({value: Infinity})],
    ["negative infinity", () => ({value: -Infinity})],
    ["custom prototype", () => Object.create({inherited: true})],
    ["Date", () => new Date(0)],
    ["Map", () => new Map()],
    ["Set", () => new Set()],
    ["typed array", () => new Uint8Array(1)],
    ["boxed primitive", () => Object(1)],
    ["symbol property", () => ({[Symbol("hidden")]: true})],
    ["array symbol property", () => Object.assign([], {[Symbol("hidden")]: true})],
    ["nonenumerable property", () => Object.defineProperty({}, "hidden", {value: true})],
    ["nonenumerable array entry", () => Object.defineProperty([], "0", {value: true})],
    ["sparse array", () => new Array(2)],
    ["deleted array entry", () => { const value = [1, 2]; delete value[0]; return value; }],
    ["array extra property", () => Object.assign([], {extra: true})],
    ["array noncanonical index", () => Object.assign([], {"01": true})],
    ["object cycle", () => { const value: {self?: unknown} = {}; value.self = value; return value; }],
    ["array cycle", () => { const value: unknown[] = []; value.push(value); return value; }],
    ...["__proto__", "constructor", "prototype"].map((key): [string, () => unknown] => [
      `forbidden key ${key}`, () => ({nested: Object.defineProperty(Object.create(null), key, {value: true, enumerable: true})}),
    ]),
  ];
  it.each(invalidValues)("rejects %s before committing", async (_label, create) => {
    const {checkpoint, port} = setup();
    await expect(checkpoint.save("response", create())).rejects.toMatchObject({
      name: "ControllerCheckpointError", key: "response", cause: expect.any(TypeError),
    });
    expect(port.commit).not.toHaveBeenCalled();
  });

  it.each(["record", "array"] as const)("rejects %s accessors without invoking them", async kind => {
    const {checkpoint, port} = setup();
    const get = vi.fn(() => "not data");
    const set = vi.fn();
    for (const descriptor of [{get}, {set}, {get: undefined, set: undefined}]) {
      const value = Object.defineProperty(kind === "record" ? {} : [], kind === "record" ? "value" : "0",
        {...descriptor, enumerable: true});
      await expect(checkpoint.save("response", value)).rejects.toBeInstanceOf(ControllerCheckpointError);
    }
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(port.commit).not.toHaveBeenCalled();
  });

  it.each(["record", "array"] as const)("preserves logical depth 64 for %s values", async kind => {
    const {checkpoint, port} = setup();
    let value: unknown = null;
    for (let depth = 0; depth < 64; depth++) value = kind === "record" ? {value} : [value];
    await checkpoint.save("depth-64", value);
    expect(checkpoint.read("depth-64")).toEqual(value);
    await expect(checkpoint.save("depth-65", kind === "record" ? {value} : [value])).rejects.toMatchObject({
      name: "ControllerCheckpointError", cause: expect.any(TypeError),
    });
    expect(port.commit).toHaveBeenCalledTimes(1);
  });

  it("still rejects invalid values after more than 100,000 valid nodes", async () => {
    const {checkpoint, port} = setup();
    await expect(checkpoint.save("response", [...Array(100_001).fill(null), {value: undefined}]))
      .rejects.toMatchObject({name: "ControllerCheckpointError", cause: {
        message: "Controller checkpoint requires plain JSON values at $[100001].value.",
      }});
    expect(port.commit).not.toHaveBeenCalled();
  });

  it("checks logical depth on each path through shared noncyclic values", async () => {
    const {checkpoint, port} = setup();
    const shared = {value: null};
    let nested: unknown = shared;
    for (let depth = 0; depth < 63; depth++) nested = [nested];
    await expect(checkpoint.save("response", {shared, nested})).rejects.toMatchObject({
      name: "ControllerCheckpointError", cause: {message: expect.stringContaining("logical depth 64")},
    });
    expect(port.commit).not.toHaveBeenCalled();
  });

  it("retains the original response after a lost commit acknowledgement", async () => {
    const {checkpoint, port, records} = setup();
    const failure = new Error("lost acknowledgement");
    port.commit.mockImplementationOnce(async (key, value) => {
      records.set(key, structuredClone(value));
      throw failure;
    });
    const response = {status: "settled", text: "retained"};
    await expect(checkpoint.save("response", response)).rejects.toMatchObject({
      name: "ControllerCheckpointError", key: "response", cause: failure,
    });
    const create = vi.fn(() => ({status: "settled", text: "replayed"}));
    expect(await new ProviderControllerCheckpoint(port).once("response", create)).toEqual(response);
    expect(create).not.toHaveBeenCalled();
    expect(port.commit).toHaveBeenCalledTimes(1);
  });
});
