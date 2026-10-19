import {describe, expect, it} from "vitest";
import {sameRunCommitValue} from "./RunCommitValue.js";

describe("retained Run commit value comparison", () => {
  it("compares nested records independently of property insertion order", () => {
    expect(sameRunCommitValue({a: [{b: 1, c: null}]}, {a: [{c: null, b: 1}]})).toBe(true);
    expect(sameRunCommitValue({a: [{b: 1}]}, {a: [{b: 2}]})).toBe(false);
    expect(sameRunCommitValue([1, 2], [2, 1])).toBe(false);
    expect(sameRunCommitValue([], {})).toBe(false);
    expect(sameRunCommitValue({a: null}, {})).toBe(false);
  });
  it("validates long retained history without Action fingerprint encoding limits", () => {
    const left = Array.from({length: 25_000}, (_, sequence) => ({sequence, content: {text: "retained", status: "settled"}}));
    const right = structuredClone(left);
    expect(sameRunCommitValue(left, right)).toBe(true);
    right[24_000]!.content.text = "changed";
    expect(sameRunCommitValue(left, right)).toBe(false);
  });
});
