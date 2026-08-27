import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { RunRef } from "@agent-anything/agent-core/run";
import type { RunActionProvenance, RunActionRef } from "@agent-anything/agent-core/run-action";
import { fail, strictRecord, token } from "../contract/OperationContractValidation.js";

export interface OperationKey {
  readonly namespace: string;
  readonly name: string;
}

export interface OperationRevisionRef {
  readonly operation: OperationKey;
  readonly revision: string;
}

export interface OperationBindingRevisionRef {
  readonly operation: OperationRevisionRef;
  readonly revision: string;
}

export interface OperationInvocationRef {
  readonly id: string;
  readonly operation: OperationRevisionRef;
}

export interface RunActionOperationCorrelation {
  readonly kind: "run_action";
  readonly run: RunRef;
  readonly runAction: RunActionRef;
  readonly provenance: RunActionProvenance;
  readonly materializationRevision: number;
}

export interface RunRequestOperationCorrelation {
  readonly kind: "run_request";
  readonly run: RunRef;
  readonly requestId: string;
  readonly runBasisRevision: number;
  readonly purpose: string;
}

export interface OwnerOperationCorrelation {
  readonly kind: "owner_operation";
  readonly owner: string;
  readonly operationId: string;
  readonly operationRevision: string;
}

export interface EvaluationTrialOperationCorrelation {
  readonly kind: "evaluation_trial";
  readonly campaignId: string;
  readonly trialId: string;
  readonly targetSnapshotId: string;
  readonly isolatedOperationId: string;
}

export type OperationCorrelation =
  | RunActionOperationCorrelation
  | RunRequestOperationCorrelation
  | OwnerOperationCorrelation
  | EvaluationTrialOperationCorrelation;

export interface OperationInvocationContext {
  readonly invocation: OperationInvocationRef;
  readonly correlation: OperationCorrelation;
  readonly parentInvocation: OperationInvocationRef | null;
  readonly interruption: InvocationInterruptionContext;
}

export function snapshotOperationKey(input: OperationKey): OperationKey {
  strictRecord(input, "OperationKey", ["namespace", "name"]);
  return Object.freeze({
    namespace: token(input.namespace, "OperationKey.namespace"),
    name: token(input.name, "OperationKey.name"),
  });
}

export function snapshotOperationRevisionRef(input: OperationRevisionRef): OperationRevisionRef {
  strictRecord(input, "OperationRevisionRef", ["operation", "revision"]);
  return Object.freeze({
    operation: snapshotOperationKey(input.operation),
    revision: token(input.revision, "OperationRevisionRef.revision"),
  });
}

export function snapshotOperationBindingRevisionRef(
  input: OperationBindingRevisionRef,
): OperationBindingRevisionRef {
  strictRecord(input, "OperationBindingRevisionRef", ["operation", "revision"]);
  return Object.freeze({
    operation: snapshotOperationRevisionRef(input.operation),
    revision: token(input.revision, "OperationBindingRevisionRef.revision"),
  });
}

export function snapshotOperationInvocationRef(
  input: OperationInvocationRef,
): OperationInvocationRef {
  strictRecord(input, "OperationInvocationRef", ["id", "operation"]);
  return Object.freeze({
    id: token(input.id, "OperationInvocationRef.id"),
    operation: snapshotOperationRevisionRef(input.operation),
  });
}

export function snapshotOperationCorrelation(
  input: OperationCorrelation,
): OperationCorrelation {
  strictRecord(input, "OperationCorrelation", [
    "kind",
    "run",
    "runAction",
    "provenance",
    "materializationRevision",
    "requestId",
    "runBasisRevision",
    "purpose",
    "owner",
    "operationId",
    "operationRevision",
    "campaignId",
    "trialId",
    "targetSnapshotId",
    "isolatedOperationId",
  ]);
  switch (input.kind) {
    case "run_action": {
      strictRecord(input, "OperationCorrelation", [
        "kind",
        "run",
        "runAction",
        "provenance",
        "materializationRevision",
      ]);
      const run = snapshotRunRef(input.run, "OperationCorrelation.run");
      const runAction = snapshotRunActionRef(
        input.runAction,
        "OperationCorrelation.runAction",
      );
      if (run.id !== runAction.run.id) {
        fail(
          "operation_identity_invalid",
          "Run Action correlation must reference the same Run.",
          "OperationCorrelation.runAction.run.id",
        );
      }
      return Object.freeze({
        kind: "run_action",
        run,
        runAction,
        provenance: snapshotRunActionProvenance(
          input.provenance,
          "OperationCorrelation.provenance",
        ),
        materializationRevision: nonNegativeInteger(
          input.materializationRevision,
          "OperationCorrelation.materializationRevision",
        ),
      });
    }
    case "run_request":
      strictRecord(input, "OperationCorrelation", [
        "kind",
        "run",
        "requestId",
        "runBasisRevision",
        "purpose",
      ]);
      return Object.freeze({
        kind: "run_request",
        run: snapshotRunRef(input.run, "OperationCorrelation.run"),
        requestId: token(input.requestId, "OperationCorrelation.requestId"),
        runBasisRevision: nonNegativeInteger(
          input.runBasisRevision,
          "OperationCorrelation.runBasisRevision",
        ),
        purpose: token(input.purpose, "OperationCorrelation.purpose"),
      });
    case "owner_operation":
      strictRecord(input, "OperationCorrelation", [
        "kind",
        "owner",
        "operationId",
        "operationRevision",
      ]);
      return Object.freeze({
        kind: "owner_operation",
        owner: token(input.owner, "OperationCorrelation.owner"),
        operationId: token(input.operationId, "OperationCorrelation.operationId"),
        operationRevision: token(
          input.operationRevision,
          "OperationCorrelation.operationRevision",
        ),
      });
    case "evaluation_trial":
      strictRecord(input, "OperationCorrelation", [
        "kind",
        "campaignId",
        "trialId",
        "targetSnapshotId",
        "isolatedOperationId",
      ]);
      return Object.freeze({
        kind: "evaluation_trial",
        campaignId: token(input.campaignId, "OperationCorrelation.campaignId"),
        trialId: token(input.trialId, "OperationCorrelation.trialId"),
        targetSnapshotId: token(
          input.targetSnapshotId,
          "OperationCorrelation.targetSnapshotId",
        ),
        isolatedOperationId: token(
          input.isolatedOperationId,
          "OperationCorrelation.isolatedOperationId",
        ),
      });
    default:
      return fail(
        "operation_identity_invalid",
        "Unsupported Operation correlation kind.",
        "OperationCorrelation.kind",
      );
  }
}

export function operationRevisionKey(ref: OperationRevisionRef): string {
  return `${ref.operation.namespace}/${ref.operation.name}@${ref.revision}`;
}

function snapshotRunRef(input: RunRef, path: string): RunRef {
  strictRecord(input, path, ["id"]);
  return Object.freeze({ id: token(input.id, `${path}.id`) });
}

function snapshotRunActionRef(input: RunActionRef, path: string): RunActionRef {
  strictRecord(input, path, ["run", "id", "sequence"]);
  return Object.freeze({
    run: snapshotRunRef(input.run, `${path}.run`),
    id: token(input.id, `${path}.id`),
    sequence: positiveInteger(input.sequence, `${path}.sequence`),
  });
}

function snapshotRunActionProvenance(
  input: RunActionProvenance,
  path: string,
): RunActionProvenance {
  strictRecord(input, path, [
    "kind",
    "turn",
    "candidateIndex",
    "workflow",
    "nodeRef",
    "trigger",
  ]);
  switch (input.kind) {
    case "controller":
      strictRecord(input, path, ["kind", "turn", "candidateIndex"]);
      strictRecord(input.turn, `${path}.turn`, ["run", "id", "sequence"]);
      return Object.freeze({
        kind: "controller",
        turn: Object.freeze({
          run: snapshotRunRef(input.turn.run, `${path}.turn.run`),
          id: token(input.turn.id, `${path}.turn.id`),
          sequence: positiveInteger(input.turn.sequence, `${path}.turn.sequence`),
        }),
        candidateIndex: nonNegativeInteger(
          input.candidateIndex,
          `${path}.candidateIndex`,
        ),
      });
    case "trusted_workflow":
      strictRecord(input, path, ["kind", "workflow", "nodeRef"]);
      strictRecord(input.workflow, `${path}.workflow`, ["owner", "invocationId"]);
      return Object.freeze({
        kind: "trusted_workflow",
        workflow: Object.freeze({
          owner: token(input.workflow.owner, `${path}.workflow.owner`),
          invocationId: token(
            input.workflow.invocationId,
            `${path}.workflow.invocationId`,
          ),
        }),
        nodeRef: token(input.nodeRef, `${path}.nodeRef`),
      });
    case "automatic":
      strictRecord(input, path, ["kind", "trigger"]);
      strictRecord(input.trigger, `${path}.trigger`, ["owner", "operationId"]);
      return Object.freeze({
        kind: "automatic",
        trigger: Object.freeze({
          owner: token(input.trigger.owner, `${path}.trigger.owner`),
          operationId: token(
            input.trigger.operationId,
            `${path}.trigger.operationId`,
          ),
        }),
      });
    default:
      return fail(
        "operation_identity_invalid",
        "Unsupported Run Action provenance kind.",
        `${path}.kind`,
      );
  }
}

function positiveInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    fail("operation_identity_invalid", `A positive integer is required at ${path}.`, path);
  }
  return input as number;
}

function nonNegativeInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    fail(
      "operation_identity_invalid",
      `A non-negative integer is required at ${path}.`,
      path,
    );
  }
  return input as number;
}
