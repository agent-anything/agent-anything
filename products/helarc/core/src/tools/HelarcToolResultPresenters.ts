import type { ToolResultPresenter } from "@agent-anything/agent-runtime/runner";
import { operationRevisionKey } from "@agent-anything/operation-catalog/identity";
import type { ToolRegistrationSnapshot } from "@agent-anything/tools/registration";
import type { OperationResult } from "@agent-anything/operation-catalog/result";
import { HELARC_SHELL_OPERATION, HELARC_TASK_OUTPUT_OPERATION } from "./HelarcCommandIdentity.js";
import type { ExecutionEvidenceRecordPort } from "@agent-anything/operation-catalog/evidence";
import { commitHelarcExecutionEvidence, helarcExecutionReferences } from "./HelarcExecutionEvidence.js";

export interface HelarcCommandResultDelivery {
  commitInitialDelivery(input: {
    readonly runId: string; readonly executionId: string | null; readonly runActionId: string; readonly settlementId: string;
    readonly observationId: string | null; readonly cursor: string | null;
  }): void | Promise<void>;
}

export function createHelarcToolResultPresenters(
  tools: ToolRegistrationSnapshot["registrations"], delivery: HelarcCommandResultDelivery,
  evidence?: ExecutionEvidenceRecordPort,
): readonly ToolResultPresenter[] {
  return Object.freeze(tools.flatMap(({descriptor}): ToolResultPresenter[] => {
    if (descriptor.binding.kind !== "operation") return [];
    const operation = operationRevisionKey(descriptor.binding.operation);
    const shell = operation === operationRevisionKey(HELARC_SHELL_OPERATION);
    const outputQuery = operation === operationRevisionKey(HELARC_TASK_OUTPUT_OPERATION);
    return [Object.freeze({tool: descriptor.ref,
      ref: Object.freeze({id: shell || outputQuery ? "helarc.command-result" : "helarc.public-operation-result", revision: evidence ? "5" : "1"}),
      ...(evidence ? {references(result: OperationResult) { return helarcExecutionReferences(result); }} : {}),
      present(result: OperationResult) {
        if ((!shell && !outputQuery) || !record(result.output) || !record(result.output.stdout) || !record(result.output.stderr)) {
          return {output: result.output, disposition: "complete" as const};
        }
        // Text is already range-bounded by the owner. Segment text is the same content again.
        const stream = (value: Record<string, unknown>) => {
          const {segments: _segments, ...summary} = value;
          return summary;
        };
        return {output: {...result.output, stdout: stream(result.output.stdout), stderr: stream(result.output.stderr)},
          disposition: result.output.has_more === true ? "bounded" as const : "complete" as const};
      },
      ...(shell || evidence ? {async committed(input: Parameters<NonNullable<ToolResultPresenter["committed"]>>[0]) {
        if (evidence) await commitHelarcExecutionEvidence(evidence, input);
        if (!shell) return;
        const content = input.presentation.content;
        const output = input.presentation.presentation.disposition !== "unavailable" && record(content) && record(content.output)
          ? content.output : null;
        return delivery.commitInitialDelivery({runId: input.runId, runActionId: input.call.parentRunAction.id,
          executionId: record(input.result.output) && typeof input.result.output.task_id === "string" ? input.result.output.task_id : null,
          settlementId: input.presentation.modelCallRef.id,
          observationId: typeof output?.observation_id === "string" ? output.observation_id : null,
          cursor: typeof output?.observation_id === "string" && typeof output?.next_cursor === "string" ? output.next_cursor : null});
      }} : {}),
    })];
  }));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
