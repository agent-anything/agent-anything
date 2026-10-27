import type {ProcessSnapshot} from "./ProcessObservation.js";
import type {ProcessOutputMaterialView} from "./ProcessOutputMaterials.js";

export type CommandObservationCondition = "snapshot" | "change" | "outcome" | "settled";
export interface CommandObservationRequest {
  readonly until: CommandObservationCondition;
  readonly after?: string;
  readonly waitMs: number;
}
export interface CommandObservation {
  readonly id: string;
  readonly invocationId: string;
  readonly request: CommandObservationRequest;
  readonly snapshot: ProcessSnapshot;
  readonly materials: readonly ProcessOutputMaterialView[];
  readonly effectiveWaitMs: number;
  readonly elapsedWaitMs: number;
  readonly returnReason: "immediate_snapshot" | "condition_satisfied" | "observation_wait_limit" | "process_unresolved" | "process_settled";
}
export function commandObservationBasis(snapshot: ProcessSnapshot, materials: readonly ProcessOutputMaterialView[]): string {
  // Revision/cwd bookkeeping alone is not an execution or output change.
  return JSON.stringify({phase:snapshot.phase, outcome:snapshot.outcome, rootExit:snapshot.rootExit,
    containment:snapshot.containment, termination:snapshot.termination, output:snapshot.output,
    limitations:snapshot.limitations, materials:materials.map(value=>value.reference)});
}
