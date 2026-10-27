import type {OperationResult} from "@agent-anything/operation-catalog/result";
import {readCompositeResultSummary} from "@agent-anything/operation-composition/result";
import type {ToolResultPresenter} from "@agent-anything/agent-runtime/execution-coordinator";

const OBSERVATION_FIELDS = [
  "task_id", "observation_id", "snapshot_revision", "phase", "outcome", "return_reason",
  "root_exit", "containment", "termination", "started_at", "finished_at", "deadline_at",
  "requested_wait_ms", "effective_wait_ms", "elapsed_wait_ms", "initial_cwd", "final_cwd",
  "session_cwd", "cwd_disposition", "output", "has_more", "limitations", "output_materials", "until", "after",
] as const;

export function presentHelarcCommandResult(result: OperationResult, shell: boolean): ReturnType<ToolResultPresenter["present"]> {
  const value = record(result.output) ? result.output : null;
  if (!shell && !value) return {output: result.output, disposition: "complete"};
  const summary = shell ? readCompositeResultSummary(result.metadata?.compositeSettlement) : null;
  const start = summary?.children.find(child => child.nodeId === "start");
  const notStarted = start !== undefined && start.status !== "succeeded" &&
    start.effectCertainty === "none" && start.completionExtent === "none";
  const execution = typeof value?.task_id === "string" ? "started" : notStarted ? "not_started" : "unknown";
  const output: Record<string, unknown> = value ? pick(value, OBSERVATION_FIELDS) : {};
  if (shell) output.execution = execution;
  if (record(value?.snapshot)) output.snapshot = snapshot(value.snapshot);
  if (value && Object.hasOwn(value, "observation")) output.observation = value.observation;
  if (value && Object.hasOwn(value, "effect_certainty")) output.effect_certainty = value.effect_certainty;
  if (record(value?.execution_descriptor)) {
    const descriptor = value.execution_descriptor;
    if (typeof descriptor.command === "string") output.command = descriptor.command;
    if (typeof descriptor.cwd === "string") output.cwd = descriptor.cwd;
  }
  for (const channel of ["stdout", "stderr"] as const) if (record(value?.[channel])) {
    const {segments: _segments, ...stream} = value[channel];
    output[channel] = stream;
  }
  // This is the declared startup dependency, not inference from a missing process handle.
  if (start?.failure?.detail) output.startup_constraint = start.failure.detail;
  let failureMessage: string | undefined;
  if (shell && result.failure) {
    if (execution === "not_started") failureMessage = result.failure.code === "interaction_expired"
      ? "The approval request expired before process startup. This command was not executed and produced no command output."
      : `The command was not started. ${result.failure.message}`.slice(0, 1_000);
    else if (result.failure.code === "command_exit_nonzero" && record(value?.root_exit) && Number.isInteger(value.root_exit.code)) {
      failureMessage = `The command exited with code ${value.root_exit.code}. See the returned stdout and stderr for diagnostics.`;
    } else if (execution === "started" && value?.observation === null) {
      failureMessage = "Process startup was confirmed, but the initial observation is unavailable. Use the returned task_id to inspect it; its outcome is not known.";
    }
  }
  return {output, disposition: value?.has_more === true ? "bounded" : "complete",
    ...(failureMessage === undefined ? {} : {failureMessage})};
}

function snapshot(value: Record<string, unknown>): Record<string, unknown> {
  return pick(value, ["phase", "outcome", "rootExit", "containment", "termination", "initialCwd", "finalCwd",
    "output", "limitations", "startedAt", "finishedAt", "deadlineAt", "revision"]);
}
function pick(value: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
