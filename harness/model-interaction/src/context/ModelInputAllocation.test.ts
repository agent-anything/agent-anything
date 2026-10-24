import {describe, expect, it} from "vitest";
import {allocateModelInput, type ModelInputAllocationUnit} from "./ModelInputAllocation.js";

const unit = (id: string, group: ModelInputAllocationUnit["group"], costs: number[]): ModelInputAllocationUnit =>
  ({id, group, forms: costs.map((cost, i) => ({id: String(i), cost, requires: []}))});

describe("whole input allocation", () => {
  it("pays required bindings first and redistributes demand-capped equal shares", () => {
    const result = allocateModelInput([unit("bindings", "request_bindings", [12]),
      unit("history", "working_conversation", [0, 4, 6, 8]), unit("material", "selected_material", [0, 2])], {target: 20});
    expect(result.selected.map(value => value.formId)).toEqual(["0", "2", "1"]);
    expect(result.used).toBe(20);
    expect(result.groups.map(value => value.unmet)).toEqual([0, 2, 0]);
  });
  it("keeps the exact baseline when there is no legal smaller form", () => {
    const result = allocateModelInput([unit("history", "working_conversation", [100])], {target: 10});
    expect(result.used).toBe(100);
    expect(result.limitations).toContain("required_baseline_exceeds_target");
  });
  it("charges shared companions once and retains source order", () => {
    const a = unit("a", "working_conversation", [2, 4]);
    const b: ModelInputAllocationUnit = {id: "b", group: "selected_material", forms: [
      {id: "0", cost: 2, requires: [{unitId: "a", formId: "0"}]},
      {id: "1", cost: 5, requires: [{unitId: "a", formId: "1"}]},
    ]};
    const result = allocateModelInput([a, b], {target: 9});
    expect(result.selected).toEqual([{unitId: "a", formId: "1"}, {unitId: "b", formId: "1"}]);
    expect(result.used).toBe(9);
  });
  it("reclaims unusable fractional grants for a whole representation", () => {
    const result = allocateModelInput([unit("a", "working_conversation", [0, 6]), unit("b", "selected_material", [0, 6])], {target: 10});
    expect(result.used).toBe(6);
    expect(result.selected[0]?.formId).toBe("1");
  });
  it("honors local reservations and rejects undeclared/missing companions", () => {
    const result = allocateModelInput([unit("a", "working_conversation", [0, 8]), unit("b", "selected_material", [0, 3])],
      {target: 8, groups: {selected_material: {reservation: 3}}});
    expect(result.selected[1]?.formId).toBe("1");
    expect(() => allocateModelInput([{id: "a", group: "working_conversation", forms: [{id: "0", cost: 1,
      requires: [{unitId: "missing", formId: "0"}]}]}], {target: 5})).toThrow("companion");
  });
  it("does not inflate top-level shares for multiple child contributions", () => {
    const result = allocateModelInput([unit("child1", "working_conversation", [0, 5]), unit("child2", "working_conversation", [0, 5]),
      unit("material", "selected_material", [0, 5])], {target: 10});
    expect(result.groups.map(group => group.used)).toEqual([0, 5, 5]);
  });
});
