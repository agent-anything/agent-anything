import type { RegisteredOperation } from "@agent-anything/operation-catalog/catalog";
import type { OperationResult, OperationResultContract } from "@agent-anything/operation-catalog/result";
import { operationRevisionKey } from "@agent-anything/operation-catalog/identity";
import { HELARC_SHELL_OPERATION, HELARC_PROCESS_START_OPERATION, HELARC_INITIAL_OBSERVATION_OPERATION, HELARC_TASK_OUTPUT_OPERATION, HELARC_TASK_STOP_OPERATION } from "./HelarcCommandIdentity.js";

export function commandResultContract(registration: RegisteredOperation): OperationResultContract {
  const key = operationRevisionKey(registration.operation.ref);
  const is = (operation: RegisteredOperation["operation"]["ref"]) => key === operationRevisionKey(operation);
  return Object.freeze({operation: registration.operation.ref, revision: registration.operation.resultSchemaRevision,
    validateOutput(result: OperationResult) {
      const value = result.output;
      const usable = result.status === "succeeded" || result.status === "partial";
      if (!usable && value === null) return true;
      if (!record(value)) return false;
      if (is(HELARC_SHELL_OPERATION)) {
        if (observation(value)) return true;
        return !usable && handle(value) && value.observation === null && value.outcome === null &&
          strings(value.limitations) && value.limitations.includes("initial_observation_unavailable");
      }
      if (is(HELARC_PROCESS_START_OPERATION)) return handle(value) && text(value.action_id) && text(value.attempt_id) && snapshot(value.snapshot);
      if (is(HELARC_TASK_STOP_OPERATION)) return text(value.task_id) && snapshot(value.snapshot) &&
        ["known_applied", "known_not_applied"].includes(value.effect_certainty as string);
      if (is(HELARC_TASK_OUTPUT_OPERATION)) return observation(value);
      if (is(HELARC_INITIAL_OBSERVATION_OPERATION)) return observation(value.observation) &&
        (value.commandFailure === null || record(value.commandFailure) && text(value.commandFailure.code) &&
          typeof value.commandFailure.message === "string" && value.commandFailure.retryable === false);
      return false;
    },
  });
}

function observation(value: unknown): boolean {
  return record(value) && handle(value) && text(value.observation_id) && text(value.invocation_id) && count(value.snapshot_revision) &&
    text(value.action_id) && text(value.phase) && (value.outcome === null || text(value.outcome)) &&
    count(value.requested_wait_ms) && count(value.effective_wait_ms) && duration(value.elapsed_wait_ms) && text(value.return_reason) &&
    stream(value.stdout) && stream(value.stderr) && text(value.next_cursor) && typeof value.has_more === "boolean" &&
    record(value.containment) && record(value.output) && strings(value.limitations);
}
function stream(value: unknown): boolean {
  return record(value) && typeof value.text === "string" && (value.encoding === null || text(value.encoding)) && text(value.encoding_source) &&
    text(value.integrity) && count(value.replacement_count) && count(value.byte_start) && count(value.byte_end) &&
    value.byte_end >= value.byte_start && count(value.received_bytes) && count(value.omitted_bytes) &&
    typeof value.projection_pending === "boolean" && Array.isArray(value.segments);
}
function snapshot(value: unknown): boolean {
  return record(value) && record(value.ref) && text(value.ref.runId) && text(value.ref.executionId) && count(value.revision) &&
    text(value.actionId) && text(value.phase) && record(value.containment) && record(value.output) && strings(value.limitations);
}
function handle(value: Record<string, unknown>): boolean { return text(value.task_id) && text(value.run_id); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function duration(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function strings(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
