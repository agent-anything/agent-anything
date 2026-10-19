import {describe, expect, it} from "vitest";
import type {OperationResult} from "@agent-anything/operation-catalog/result";
import {presentToolResultReferences, snapshotToolResultPresenters, type ToolResultPresenter} from "./ToolResultPresenter.js";

const result = {} as OperationResult;
const reference = {owner: "owner", kind: "execution", id: "result-1", revision: "1"};
const presenter: ToolResultPresenter = {tool: {tool: {namespace: "owner", name: "read"}, revision: "1"},
  ref: {id: "presenter", revision: "1"}, present: () => ({output: null, disposition: "complete"}), references: () => [reference]};

describe("Tool result references", () => {
  it("snapshots pure locators independently of body presentation", () => {
    const retained = snapshotToolResultPresenters([presenter])[0]!;
    const refs = presentToolResultReferences(retained, result);
    expect(refs).toEqual([reference]);
    expect(refs[0]).not.toBe(reference);
    expect(Object.isFrozen(refs[0])).toBe(true);
    expect(presentToolResultReferences(undefined, result)).toEqual([]);
  });
  it.each([null, [{...reference, id: " padded "}], [{...reference, revision: undefined}],
    [{...reference, secret: "not a locator"}], [reference, reference], Array(17).fill(reference), Array(1)].map(candidate => ({candidate})))(
    "rejects malformed, duplicate, sparse or excessive locator lists", ({candidate}) => {
      expect(() => presentToolResultReferences({...presenter, references: () => candidate} as ToolResultPresenter, result)).toThrow();
    });
  it("bounds aggregate locator text separately from the result body", () => {
    const references = Array.from({length: 16}, (_, index) => ({...reference, id: `${index}-${"x".repeat(1000)}`}));
    expect(() => presentToolResultReferences({...presenter, references: () => references}, result)).toThrow("capacity");
  });
});
