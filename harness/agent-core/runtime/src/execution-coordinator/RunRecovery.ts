import type { AgentDefinition } from "@agent-anything/agent-core/agent";
import type { RunConfig } from "./RunConfig.js";
import type { RetainedRunTreeMember } from "./RunTreeCommitPort.js";
import { createRunResult, type RunState, type RunResult } from "../run/index.js";

export interface RunRecoveryBindings {
  resolve(member: RetainedRunTreeMember): Promise<{readonly agent: AgentDefinition; readonly config: RunConfig}>;
}

/** Unresolved recovery is not a new failed execution or permission to replay work. */
export class RunRecoveryError extends Error {
  constructor(readonly runId: string, readonly code: string, readonly subjectId: string) {
    super(`Run recovery requires reconciliation: ${code} (${subjectId}).`);
    this.name = "RunRecoveryError";
  }
}

export function retainedRunResult(state: RunState): RunResult | null {
  if (state.settlement === null || state.settlementCause === null) return null;
  return createRunResult({runId: state.run.id, taskId: state.taskId,
    startingAgent: state.startingAgent, finalActiveAgent: state.activeAgent,
    startingInstructionBinding: state.startingInstructionBinding, finalInstructionBinding: state.activeInstructionBinding,
    startedAt: state.startedAt, settlement: state.settlement, cause: state.settlementCause,
    settlementCauses: state.settlementCauses, items: state.items, evidenceRefs: state.evidenceRefs,
    artifactRefs: state.artifactRefs, metadata: state.metadata});
}
