import { invalidOperationBinding, snapshotResolvedOperationBinding, type OperationBindingResolverSnapshot } from "@agent-anything/operation-catalog/binding";
import { snapshotExecutionEvidenceRef, ExecutionEvidenceUnavailableError, resolveCompensationAssociation, type ExecutionEvidenceRecordPort, type ExecutionEvidenceAccessPort } from "@agent-anything/operation-catalog/evidence";
import { operationRevisionKey } from "@agent-anything/operation-catalog/identity";
import { OperationCommitError } from "@agent-anything/operation-catalog/result";
import type { ToolCall } from "@agent-anything/tools/invocation";
import type { ToolRegistrationInput } from "@agent-anything/tools/registration";
import { HELARC_COMPENSATION_INPUT_REVISION, readHelarcCompensationInput, withoutHelarcCompensationInput } from "./HelarcCompensationInput.js";
import { ownExecutionAccess } from "./HelarcExecutionDetails.js";

export function createHelarcCompensationBindings(input: {
  readonly bindings: OperationBindingResolverSnapshot;
  readonly tools: readonly ToolRegistrationInput[];
  readonly records?: ExecutionEvidenceRecordPort;
  readonly access?: ExecutionEvidenceAccessPort;
}): OperationBindingResolverSnapshot {
  const participants = new Set(input.tools.flatMap(({descriptor}) => descriptor.binding.kind === "operation" &&
    descriptor.metadata?.compensationInputRevision === HELARC_COMPENSATION_INPUT_REVISION
    ? [operationRevisionKey(descriptor.binding.operation)] : []));
  const derived = new Set(input.tools.flatMap(({descriptor}) => descriptor.binding.kind === "operation" && descriptor.metadata?.compensationTargetInput === "change_ref"
    ? [operationRevisionKey(descriptor.binding.operation)] : []));
  return Object.freeze({...input.bindings, revision: `${input.bindings.revision}.${HELARC_COMPENSATION_INPUT_REVISION}`,
    async resolve(request: Parameters<OperationBindingResolverSnapshot["resolve"]>[0]) {
      if (!participants.has(operationRevisionKey(request.operation.operation.ref))) return input.bindings.resolve(request);
      let proposal: ReturnType<typeof readHelarcCompensationInput>;
      try {
        if (derived.has(operationRevisionKey(request.operation.operation.ref))) {
          const value = request.request as {change_ref: import("@agent-anything/operation-catalog/evidence").ExecutionEvidenceRef<"effect">};
          proposal = {targets: [snapshotExecutionEvidenceRef(value.change_ref, "effect")], explanation: null};
        } else proposal = readHelarcCompensationInput(request.request);
      }
      catch { return rejected("compensation_input_invalid", "Use compensation_of with unique exact execution/effect targets from Tool results and an optional explanation."); }
      if (proposal === null) return input.bindings.resolve(request);
      const correlation = request.context.correlation;
      const call = request.basis as ToolCall | undefined;
      if (correlation.kind !== "run_action" || correlation.provenance.kind !== "controller" ||
          !call || call.origin !== "model" || !call.attempt?.modelCall ||
          call.parentRunAction?.run.id !== correlation.run.id || call.parentRunAction.id !== correlation.runAction.id ||
          call.parentRunAction.sequence !== correlation.runAction.sequence ||
          call.binding?.kind !== "operation" || operationRevisionKey(call.binding.operation) !== operationRevisionKey(request.operation.operation.ref)) {
        return rejected("compensation_caller_invalid", "Compensation association requires an accepted model Tool Call in this Run.");
      }
      if (!input.records) return rejected("execution_reference_unavailable", "Execution evidence storage is unavailable; no operation was executed. Ordinary work can omit compensation_of.");
      const records = input.records;
      let association;
      try {
        association = await resolveCompensationAssociation({runId: correlation.run.id, records,
          access: input.access ?? ownExecutionAccess,
          proposal: {id: `${request.context.invocation.id}:compensation`, invocation: request.context.invocation,
            correlation, call: {id: call.attempt.modelCall.id, turnId: correlation.provenance.turn.id},
            targets: proposal.targets, explanation: proposal.explanation, acceptedAt: call.createdAt}});
      } catch (cause) {
        if (cause instanceof ExecutionEvidenceUnavailableError) return rejected(cause.code, cause.message);
        throw new OperationCommitError("helarc.execution-evidence", request.context.invocation.id, {cause});
      }
      const resolved = await input.bindings.resolve({...request, request: withoutHelarcCompensationInput(request.request)});
      if (resolved.status !== "resolved") return resolved;
      const binding = snapshotResolvedOperationBinding({...resolved.binding, compensation: association,
        resolutionFingerprint: `${resolved.binding.resolutionFingerprint}:${association.id}`}, value => value);
      try { await records.commitCompensationAssociation(association); }
      catch (cause) { throw new OperationCommitError("helarc.execution-evidence", association.id, {cause}); }
      return Object.freeze({status: "resolved" as const, binding});
    },
  });
}

function rejected(code: string, message: string) { return invalidOperationBinding("helarc", code, message); }
