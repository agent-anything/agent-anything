import type { Action, ActionKind } from "@agent-anything/agent-core/action";
import { describe, expect, it } from "vitest";
import { routeRunAction } from "./RunActionRouter.js";

describe("routeRunAction", () => {
  it("classifies only the Runner-supported semantic routes", () => {
    expect(routeRunAction(action("internal", "update_plan"))).toBe(
      "plan_update",
    );
    expect(routeRunAction(action("tool", "codeAgent.readFile"))).toBe("tool");
    expect(routeRunAction(action(
      "permission_request",
      "request_permissions",
    ))).toBe("permission_request");
    expect(routeRunAction(action("internal", "unknown_internal"))).toBe(
      "unsupported",
    );
  });
});

function action(kind: ActionKind, name: string): Action {
  return Object.freeze({
    id: `action-${name}`,
    runId: "run-1",
    sequence: 1,
    kind,
    name,
    input: Object.freeze({}),
    provenance: Object.freeze({
      origin: "model",
      modelItemId: "model-1",
      controllerIteration: 1,
    }),
  });
}
