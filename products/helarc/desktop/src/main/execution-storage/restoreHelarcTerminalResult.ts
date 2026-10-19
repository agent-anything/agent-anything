import { retainedRunResult, type RunTreeRecoveryRecords } from "@agent-anything/agent-runtime/runner";
import type { RunResult } from "@agent-anything/agent-runtime/run";
import { createHostTerminalRunProjection } from "@agent-anything/host/projection";
import { projectHelarcProductResult } from "@agent-anything/helarc/composition";
import type { HelarcAgentOutput } from "@agent-anything/helarc/controller";
import type { HelarcExecutionAdmission } from "./HelarcExecutionAdmission.js";
import type { HelarcHostRunResult } from "../run/HelarcHostRunComposition.js";

/** Pure delivery reconstruction; no Provider, Shell, permission or Hook execution. */
export function restoreHelarcTerminalResult(saved: HelarcExecutionAdmission, records: RunTreeRecoveryRecords): HelarcHostRunResult {
  const root = records.members.find(member => member.head.state.run.id === saved.rootRunId);
  const runResult = root ? retainedRunResult(root.head.state) as RunResult<HelarcAgentOutput> | null : null;
  if (!runResult || runResult.taskId !== saved.task.id) throw new Error("Retained terminal result is unavailable.");
  return {kind: "run_result", productRunId: saved.productRunId, harnessRunId: saved.rootRunId, runResult,
    terminal: createHostTerminalRunProjection({runResult, completedAt: runResult.completedAt}),
    product: projectHelarcProductResult(saved.task, saved.workspace, runResult, saved.enforcement, saved.qualification),
    activity: []};
}
