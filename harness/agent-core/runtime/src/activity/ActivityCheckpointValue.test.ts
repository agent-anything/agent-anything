import {describe, expect, it} from "vitest";
import {assertControllerCheckpointValue, isImmutableActivityValue} from "./ActivityCheckpointValue.js";

describe("immutable activity validation prerequisites", () => {
  it("proves the entire data graph, without treating immutability as validity", () => {
    const record=Object.freeze({list:Object.freeze([Object.freeze({value:1})])});
    expect(isImmutableActivityValue(record)).toBe(true);
    expect(isImmutableActivityValue(record)).toBe(true);
    expect(isImmutableActivityValue(Object.freeze({list:[]}))).toBe(false);
    expect(isImmutableActivityValue(Object.freeze(new Date()))).toBe(false);
    expect(isImmutableActivityValue(Object.freeze({get value(){throw new Error("must not evaluate");}}))).toBe(false);
    const cycle:{next?:unknown}={};cycle.next=cycle;Object.freeze(cycle);
    expect(isImmutableActivityValue(cycle)).toBe(false);
    const invalid=Object.freeze({constructor:1});
    expect(isImmutableActivityValue(invalid)).toBe(true);
    expect(()=>assertControllerCheckpointValue(invalid)).toThrow("prototype control");
  });
});
