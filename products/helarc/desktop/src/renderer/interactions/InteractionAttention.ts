import type { HelarcMainSnapshot, HelarcPendingInteractionSnapshot } from "../../shared/HelarcDesktopApi.js";

export function currentInteractionRequests(snapshot: HelarcMainSnapshot): readonly HelarcPendingInteractionSnapshot[] {
  return snapshot.execution === "active" && snapshot.run && !snapshot.run.display.terminal
    ? snapshot.run.host.pendingInteractions
    : [];
}

export function requiresUserInput(request: HelarcPendingInteractionSnapshot): boolean {
  return request.phase === "pending" &&
    (request.family === "approval" || request.family === "clarification");
}
