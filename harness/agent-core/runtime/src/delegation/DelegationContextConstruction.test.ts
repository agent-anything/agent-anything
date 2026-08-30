import { describe, expect, it } from "vitest";
import {
  createDelegationContextMaterial,
  type DelegationRequest,
} from "./DelegationRequest.js";
import { assessDelegationContextConstruction } from "./DelegationContextConstruction.js";

describe("delegation Context construction", () => {
  it("selects only exact admitted materials and reports optional omissions", () => {
    const selected = createDelegationContextMaterial({
      owner: "product",
      kind: "workspace_fact",
      id: "workspace-1",
      payload: Object.freeze({ primaryRoot: "workspace-1" }),
    });
    const optional = Object.freeze({
      owner: "product",
      kind: "project_context",
      id: "project-context-1",
      revision: "1",
    });
    const request = requestWithEntries([
      { role: "workspace", material: selected.ref, necessity: "mandatory" },
      { role: "product_context", material: optional, necessity: "optional" },
    ]);

    expect(assessDelegationContextConstruction({
      request,
      materials: [selected],
    })).toEqual({
      selected: [selected],
      omitted: [optional],
    });
  });

  it("rejects missing mandatory and unselected material", () => {
    const selected = createDelegationContextMaterial({
      owner: "parent",
      kind: "fact",
      id: "fact-1",
      payload: Object.freeze({ value: "selected" }),
    });
    const extra = createDelegationContextMaterial({
      owner: "parent",
      kind: "fact",
      id: "fact-2",
      payload: Object.freeze({ value: "not selected" }),
    });
    const request = requestWithEntries([{
      role: "parent_fact",
      material: selected.ref,
      necessity: "mandatory",
    }]);

    expect(() => assessDelegationContextConstruction({ request, materials: [] }))
      .toThrow("is unavailable");
    expect(() => assessDelegationContextConstruction({
      request,
      materials: [selected, extra],
    })).toThrow("was not selected");
  });
});

function requestWithEntries(
  entries: DelegationRequest["contextPlan"]["entries"],
): DelegationRequest {
  return { contextPlan: { entries } } as DelegationRequest;
}
