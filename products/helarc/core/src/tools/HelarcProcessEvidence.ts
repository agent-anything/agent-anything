import {operationDefinitionRevisionKey} from "@agent-anything/operation-catalog/identity";
import type {OperationResult} from "@agent-anything/operation-catalog/result";
import type {EvidenceData, ExecutionEffectEvidence, ExecutionEffectSchema, ExecutionCompensationSupport} from "@agent-anything/operation-catalog/evidence";
import {HELARC_SHELL_OPERATION, HELARC_COMMAND_OBSERVE_OPERATION, HELARC_COMMAND_OBSERVE_BINDING, HELARC_TASK_STOP_OPERATION, HELARC_TASK_STOP_BINDING} from "./HelarcCommandIdentity.js";

const schema = {owner: "helarc", id: "managed-process-observation", revision: "1"};
export const HELARC_PROCESS_EFFECT_SCHEMA: ExecutionEffectSchema = {...schema, validate(value) {
  return record(value) && typeof value.task_id === "string" && typeof value.run_id === "string" &&
    typeof value.phase === "string" && record(value.containment) && Array.isArray(value.limitations);
}};

/** Process facts have a narrower scope than the arbitrary external effects of the command. */
export function helarcProcessEvidence(result: OperationResult): {effects: readonly ExecutionEffectEvidence[]; support: readonly ExecutionCompensationSupport[]} {
  const key = operationDefinitionRevisionKey(result.binding.operation);
  const shell = key === operationDefinitionRevisionKey(HELARC_SHELL_OPERATION);
  const stop = key === operationDefinitionRevisionKey(HELARC_TASK_STOP_OPERATION);
  if (result.semanticOwner !== "helarc" || !shell && !stop && key !== operationDefinitionRevisionKey(HELARC_COMMAND_OBSERVE_OPERATION) || !record(result.output)) return {effects: [], support: []};
  const output = result.output, snapshot = record(output.snapshot) ? output.snapshot : null;
  const ref = snapshot && record(snapshot.ref) ? snapshot.ref : null;
  const taskId = output.task_id, runId = output.run_id ?? ref?.runId;
  if (typeof taskId !== "string" || typeof runId !== "string") return {effects: [], support: []};
  const facts = snapshot ? {task_id: taskId, run_id: runId, phase: snapshot.phase, outcome: snapshot.outcome ?? null,
    containment: snapshot.containment, root_exit: snapshot.rootExit ?? null, termination: snapshot.termination ?? null,
    initial_cwd: snapshot.initialCwd ?? null, final_cwd: snapshot.finalCwd ?? null, output: snapshot.output ?? null, limitations: snapshot.limitations} :
    Object.fromEntries(["task_id", "run_id", "phase", "outcome", "containment", "root_exit", "termination", "initial_cwd", "final_cwd", "output", "limitations", "next_cursor"].map(k => [k, output[k] ?? null]));
  if (!HELARC_PROCESS_EFFECT_SCHEMA.validate(facts as EvidenceData)) return {effects: [], support: []};
  const effect: ExecutionEffectEvidence = {ref: {owner: "helarc", kind: "effect", id: `${result.ref.id}:process`, revision: "1"}, schema,
    summary: `Managed process ${taskId}: ${facts.phase}`,
    coverage: {scope: "Observed managed process lifecycle, containment and output capture", extent: "partial",
      limitations: ["Does not enumerate or undo command filesystem/network/service effects.", "PID alone does not identify a live manageable process."]},
    evidence: result.lowerRefs, value: {...facts, execution_descriptor: output.execution_descriptor ?? null,
      stop_effect_certainty: output.effect_certainty ?? null} as EvidenceData};
  const support: ExecutionCompensationSupport = {ref: {owner: "helarc", kind: "support", id: `${result.ref.id}:process-support`, revision: "1"},
    effects: [effect.ref], summary: "Owned process inspection/stopping and retained output; no general command inverse.", coverage: effect.coverage,
    materials: [], guidance: [JSON.stringify({task_id: taskId, run_id: runId, output_materials:output.output_materials ?? []}),
      "CommandObserve and CommandStop accept the exact task_id only in its owning live Run. A transferred reference does not transfer process control.",
      "Use retained output while available; output capture limits and expiry are independent of historical process facts. Stopping does not undo earlier external effects."],
    callables: [
      {binding: HELARC_COMMAND_OBSERVE_BINDING, referenceInput: "task_id", objective: "Observe current lifecycle or wait for a condition and obtain retained output references.", preconditions: ["Same owning Run and available process identity"], limitations: ["Read or search returned material references separately with ContextMaterialRead/ContextMaterialSearch."]},
      ...(facts.phase === "settled" ? [] : [{binding: HELARC_TASK_STOP_BINDING, referenceInput: "task_id", objective: "Stop the exact owned managed process scope.", preconditions: ["Current permission and valid managed process identity"], limitations: ["No reversal of earlier command effects; unknown containment is reported, not guessed."]}]),
    ]};
  return {effects: [effect], support: [support]};
}
function record(value: unknown): value is Record<string, unknown> {return value !== null && typeof value === "object" && !Array.isArray(value);}
