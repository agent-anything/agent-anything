import type { Action } from "@agent-anything/agent-core/action";

export type RunActionRoute =
  | "plan_update"
  | "tool"
  | "permission_request"
  | "unsupported";

export function routeRunAction(action: Action): RunActionRoute {
  if (action.kind === "internal" && action.name === "update_plan") {
    return "plan_update";
  }
  if (action.kind === "tool") {
    return "tool";
  }
  if (action.kind === "permission_request") {
    return "permission_request";
  }
  return "unsupported";
}
