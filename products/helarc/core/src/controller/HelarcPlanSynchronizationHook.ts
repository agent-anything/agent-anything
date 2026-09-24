import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import {
  createAgentHookComposition,
  type AgentHookComposition,
  type AgentStopHandler,
  type AgentStopHandlerResult,
} from "@agent-anything/agent-hooks/composition";
import type { AgentStopEvent } from "@agent-anything/agent-hooks/events";

const REVISION = "helarc.plan-synchronization.v1";
const HANDLER_REF = Object.freeze({ id: "helarc.plan-synchronization.handler", revision: REVISION });
const ALLOW = Object.freeze({ disposition: "allow" as const });
const FEEDBACK = Object.freeze({
  disposition: "continue" as const,
  code: "plan_synchronization_requested",
  message: [
    "Your current Plan still records pending or in_progress steps.",
    "Before your final response, reconcile the Plan with the actual results and call update_plan if its recorded progress needs updating.",
    "Keep still-relevant unfinished steps and explain any remaining limitations; do not mark them completed merely because this Run is ending.",
    "If the Plan already accurately records unfinished work, explain that in your final response without repeating an unchanged update.",
    "This is a one-time synchronization reminder, not a requirement to complete every step or continue otherwise unnecessary work.",
  ].join(" "),
});

export class HelarcPlanSynchronizationHook implements AgentStopHandler {
  private readonly remindedRuns = new Set<string>();

  handle(event: AgentStopEvent, interruption: InvocationInterruptionContext): AgentStopHandlerResult {
    if (interruption.signal.aborted || this.remindedRuns.has(event.run.id) ||
        event.plan?.status !== "active" ||
        !event.plan.steps.some(({ status }) => status === "pending" || status === "in_progress")) {
      return ALLOW;
    }
    // Plan replacements and intervening Tool calls must not renew the reminder.
    this.remindedRuns.add(event.run.id);
    return FEEDBACK;
  }
}

export function createHelarcPlanSynchronizationHookComposition(): AgentHookComposition {
  return createAgentHookComposition({
    id: "helarc.plan-synchronization",
    revision: REVISION,
    registrations: [{
      ref: { owner: "helarc", id: "helarc.plan-synchronization.stop", revision: REVISION },
      point: "Stop",
      mode: "blocking",
      runKinds: ["root", "descendant"],
      handler: HANDLER_REF,
      timeoutMs: 1_000,
      maximumResultBytes: 2_048,
    }],
    bindings: [{
      ref: HANDLER_REF,
      point: "Stop",
      mode: "blocking",
      handler: new HelarcPlanSynchronizationHook(),
    }],
  });
}
