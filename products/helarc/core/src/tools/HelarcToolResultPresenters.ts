import type { ToolResultPresenter } from "@agent-anything/agent-runtime/execution-coordinator";
import {isDeepStrictEqual} from "node:util";
import { operationDefinitionRevisionKey } from "@agent-anything/operation-catalog/identity";
import type { ToolRegistrationSnapshot } from "@agent-anything/tools/registration";
import type { OperationResult } from "@agent-anything/operation-catalog/result";
import { HELARC_SHELL_OPERATION, HELARC_COMMAND_OBSERVE_OPERATION, HELARC_TASK_STOP_OPERATION } from "./HelarcCommandIdentity.js";
import type { ExecutionEvidenceRecordPort } from "@agent-anything/operation-catalog/evidence";
import { commitHelarcExecutionEvidence, helarcExecutionReferences } from "./HelarcExecutionEvidence.js";
import {presentHelarcCommandResult} from "./HelarcCommandResultPresentation.js";

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
    const operation = operationDefinitionRevisionKey(descriptor.binding.operation);
    const shell = operation === operationDefinitionRevisionKey(HELARC_SHELL_OPERATION);
    const commandObservation = operation === operationDefinitionRevisionKey(HELARC_COMMAND_OBSERVE_OPERATION);
    const stop = operation === operationDefinitionRevisionKey(HELARC_TASK_STOP_OPERATION);
    const contextAccess = descriptor.binding.operation.operation.namespace === "helarc" &&
      ["context-read", "context-search"].includes(descriptor.binding.operation.operation.name);
    return [Object.freeze({tool: descriptor.ref,
      ref: Object.freeze({id: contextAccess ? "helarc.context-access-result" : shell || commandObservation || stop ? "helarc.command-result" : "helarc.public-operation-result", revision: evidence ? "7" : "3"}),
      ...(evidence ? {references(result: OperationResult) { return helarcExecutionReferences(result); }} : {}),
      present(result: OperationResult) {
        return shell || commandObservation || stop ? presentHelarcCommandResult(result, shell)
          : {output: result.output, disposition: "complete" as const};
      },
      ...(shell || evidence ? {async committed(input: Parameters<NonNullable<ToolResultPresenter["committed"]>>[0]) {
        if (evidence) await commitHelarcExecutionEvidence(evidence, input);
        if (!shell) return;
        const content = input.presentation.content;
        const output = input.presentation.presentation.disposition !== "unavailable" && record(content) && record(content.output)
          ? content.output : null;
        const source = record(input.result.output) ? input.result.output : null;
        const expected = presentHelarcCommandResult(input.result, true).output;
        // The private cursor is usable only when the exact bounded preview was delivered.
        const delivered = output !== null && record(expected) && typeof source?.observation_id === "string" &&
          typeof source.next_cursor === "string" && output.observation_id === source.observation_id &&
          isDeepStrictEqual(output.stdout, expected.stdout) && isDeepStrictEqual(output.stderr, expected.stderr);
        return delivery.commitInitialDelivery({runId: input.runId, runActionId: input.call.parentRunAction.id,
          executionId: record(input.result.output) && typeof input.result.output.task_id === "string" ? input.result.output.task_id : null,
          settlementId: input.presentation.modelCallRef.id,
          observationId: delivered ? source.observation_id as string : null,
          cursor: delivered ? source.next_cursor as string : null});
      }} : {}),
    })];
  }));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
