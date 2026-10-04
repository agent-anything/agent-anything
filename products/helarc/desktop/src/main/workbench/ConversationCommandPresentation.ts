import type { HelarcCommandProgress } from "@agent-anything/helarc/run";
import type { ConversationActivityItem } from "../../shared/HelarcWorkbench.js";

export function commandActivity(c: HelarcCommandProgress, active: boolean): ConversationActivityItem {
  const phases: Record<string, string> = {
    starting: "Starting", running: "Running", draining: "Finishing output capture",
    stopping: "Stopping", terminating: "Stopping", unresolved: "Process state unresolved",
  };
  const phase = phases[c.phase] ?? "Execution pending";
  const settled = c.outcome !== null || c.phase === "settled";
  const outcomes: Record<string, string> = {
    succeeded: "Completed", failed: "Failed", cancelled: "Cancelled",
    timed_out: "Timed out", unknown: "Outcome uncertain",
  };
  const outcome = outcomes[c.outcome ?? ""] ?? "Outcome unavailable";
  return {
    id: c.executionId, runId: c.runId, kind: "command",
    title: (c.command ?? "Shell command").replace(/\s+/g, " ").trim().slice(0, 200),
    attribution: null,
    state: settled ? "settled" : active ? "ongoing" : "inactive",
    status: settled
      ? `${outcome}${c.exitCode == null ? "" : ` (root exit code ${c.exitCode})`}${c.phase === "settled" ? "" : "; resources still managed"}`
      : active ? phase : `Last observed: ${phase}`,
    startedAt: c.startedAt ?? null, endedAt: c.completedAt ?? null,
    observedAt: c.observedAt,
    detail: { kind: "command", executionId: c.executionId }, child: null,
  };
}
