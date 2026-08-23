import { describe, expect, it } from "vitest";
import {
  createDescendantRunLineage,
  createDescendantRunRelation,
  createRootRunLineage,
} from "./RunTree.js";

describe("Agent Core Run Tree contracts", () => {
  it("creates immutable root lineage from one Run identity", () => {
    const lineage = createRootRunLineage({ id: "run-root" });

    expect(lineage).toEqual({
      kind: "root",
      root: { id: "run-root" },
      depth: 0,
    });
    expect(Object.isFrozen(lineage)).toBe(true);
    expect(Object.isFrozen(lineage.root)).toBe(true);
  });

  it("creates one descendant relation and derived lineage", () => {
    const relation = createDescendantRunRelation({
      relationId: "relation-1",
      root: { id: "run-root" },
      parent: { id: "run-parent" },
      child: { id: "run-child" },
      parentRunAction: {
        run: { id: "run-parent" },
        id: "action-1",
        sequence: 2,
      },
      depth: 2,
    });
    const lineage = createDescendantRunLineage(relation);

    expect(lineage).toEqual({
      kind: "descendant",
      root: { id: "run-root" },
      parent: { id: "run-parent" },
      parentRunAction: {
        run: { id: "run-parent" },
        id: "action-1",
        sequence: 2,
      },
      relation: { id: "relation-1" },
      depth: 2,
    });
    expect(Object.isFrozen(relation)).toBe(true);
    expect(Object.isFrozen(lineage)).toBe(true);
  });

  it("rejects a creating RunAction from another Run", () => {
    expect(() => createDescendantRunRelation({
      relationId: "relation-1",
      root: { id: "run-root" },
      parent: { id: "run-parent" },
      child: { id: "run-child" },
      parentRunAction: {
        run: { id: "run-other" },
        id: "action-1",
        sequence: 1,
      },
      depth: 1,
    })).toThrow(/creating RunAction/);
  });
});
