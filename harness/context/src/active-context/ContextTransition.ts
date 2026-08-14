import type {
  ContextContribution,
  ContextContributionRef,
} from "../contribution/ContextContribution.js";
import {
  snapshotContextContribution,
  snapshotContextContributionRef,
} from "../contribution/ContextContribution.js";
import {
  fail,
  isoDateTime,
  nullableToken,
  strictRecord,
  token,
} from "../contract/ContextContractValidation.js";
import type { ActiveContextItemRef, ActiveContextRef } from "./ActiveContext.js";
import { snapshotActiveContextRef } from "./ActiveContext.js";

export interface ContextTransitionProposer {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
}

export interface ContextTransitionCause {
  readonly kind: string;
  readonly id: string | null;
}

export interface AddContextOperation {
  readonly kind: "add";
  readonly item: ActiveContextItemRef;
  readonly contribution: ContextContribution;
}

export interface ReplaceContextOperation {
  readonly kind: "replace";
  readonly item: ActiveContextItemRef;
  readonly expectedContribution: ContextContributionRef;
  readonly contribution: ContextContribution;
}

export interface InvalidateContextOperation {
  readonly kind: "invalidate";
  readonly item: ActiveContextItemRef;
  readonly expectedContribution: ContextContributionRef;
  readonly reason: string;
}

export interface RemoveContextOperation {
  readonly kind: "remove";
  readonly item: ActiveContextItemRef;
  readonly expectedContribution: ContextContributionRef;
  readonly reason: string;
}

export type ContextTransitionOperation =
  | AddContextOperation
  | ReplaceContextOperation
  | InvalidateContextOperation
  | RemoveContextOperation;

export interface ContextTransition {
  readonly id: string;
  readonly base: ActiveContextRef;
  readonly proposer: ContextTransitionProposer;
  readonly cause: ContextTransitionCause;
  readonly correlationId: string | null;
  readonly operations: readonly ContextTransitionOperation[];
  readonly createdAt: string;
}

export function snapshotContextTransition(
  input: ContextTransition,
  limits: { readonly maxContributionPayloadBytes: number },
): ContextTransition {
  strictRecord(input, "ContextTransition", [
    "id", "base", "proposer", "cause", "correlationId", "operations",
    "createdAt",
  ], "context_transition_invalid");
  strictRecord(limits, "ContextTransitionLimits", [
    "maxContributionPayloadBytes",
  ], "context_transition_invalid");
  if (
    !Number.isSafeInteger(limits.maxContributionPayloadBytes) ||
    limits.maxContributionPayloadBytes < 0
  ) {
    fail(
      "context_transition_invalid",
      "ContextTransition payload limit must be a non-negative safe integer.",
      "ContextTransitionLimits.maxContributionPayloadBytes",
    );
  }
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    fail(
      "context_transition_invalid",
      "ContextTransition operations must be a non-empty array.",
      "ContextTransition.operations",
    );
  }
  const operations = input.operations.map((operation, index) =>
    snapshotOperation(
      operation,
      limits.maxContributionPayloadBytes,
      `ContextTransition.operations[${index}]`,
    ),
  );
  const itemIds = operations.map((operation) => operation.item.id);
  if (new Set(itemIds).size !== itemIds.length) {
    fail(
      "context_transition_invalid",
      "A ContextTransition can operate on each item at most once.",
      "ContextTransition.operations",
    );
  }
  const base = snapshotActiveContextRef(input.base, "ContextTransition.base");
  for (const operation of operations) {
    if (
      "contribution" in operation &&
      operation.contribution.scope.runId !== base.runId
    ) {
      fail(
        "context_transition_invalid",
        "ContextTransition Contributions must belong to the base Run.",
        "ContextTransition.operations",
      );
    }
  }
  return Object.freeze({
    id: token(
      input.id,
      "ContextTransition.id",
      "context_transition_invalid",
    ),
    base,
    proposer: snapshotProposer(input.proposer),
    cause: snapshotCause(input.cause),
    correlationId: nullableToken(
      input.correlationId,
      "ContextTransition.correlationId",
      "context_transition_invalid",
    ),
    operations: Object.freeze(operations),
    createdAt: isoDateTime(
      input.createdAt,
      "ContextTransition.createdAt",
      "context_transition_invalid",
    ),
  });
}

function snapshotOperation(
  input: ContextTransitionOperation,
  maxPayloadBytes: number,
  path: string,
): ContextTransitionOperation {
  strictRecord(input, path, [
    "kind", "item", "expectedContribution", "contribution", "reason",
  ], "context_transition_invalid");
  const item = snapshotItemRef(input.item, `${path}.item`);
  switch (input.kind) {
    case "add":
      strictRecord(input, path, ["kind", "item", "contribution"], "context_transition_invalid");
      return Object.freeze({
        kind: "add",
        item,
        contribution: snapshotContextContribution(input.contribution, {
          maxPayloadBytes,
        }),
      });
    case "replace":
      strictRecord(input, path, [
        "kind", "item", "expectedContribution", "contribution",
      ], "context_transition_invalid");
      return Object.freeze({
        kind: "replace",
        item,
        expectedContribution: snapshotContextContributionRef(
          input.expectedContribution,
        ),
        contribution: snapshotContextContribution(input.contribution, {
          maxPayloadBytes,
        }),
      });
    case "invalidate":
    case "remove":
      strictRecord(input, path, [
        "kind", "item", "expectedContribution", "reason",
      ], "context_transition_invalid");
      return Object.freeze({
        kind: input.kind,
        item,
        expectedContribution: snapshotContextContributionRef(
          input.expectedContribution,
        ),
        reason: token(
          input.reason,
          `${path}.reason`,
          "context_transition_invalid",
        ),
      });
    default:
      return fail(
        "context_transition_invalid",
        "ContextTransition operation kind is invalid.",
        `${path}.kind`,
      );
  }
}

function snapshotItemRef(input: ActiveContextItemRef, path: string): ActiveContextItemRef {
  strictRecord(input, path, ["id"], "context_transition_invalid");
  return Object.freeze({
    id: token(input.id, `${path}.id`, "context_transition_invalid"),
  });
}

function snapshotProposer(input: ContextTransitionProposer): ContextTransitionProposer {
  strictRecord(input, "ContextTransition.proposer", [
    "owner", "kind", "id",
  ], "context_transition_invalid");
  return Object.freeze({
    owner: token(input.owner, "ContextTransition.proposer.owner", "context_transition_invalid"),
    kind: token(input.kind, "ContextTransition.proposer.kind", "context_transition_invalid"),
    id: token(input.id, "ContextTransition.proposer.id", "context_transition_invalid"),
  });
}

function snapshotCause(input: ContextTransitionCause): ContextTransitionCause {
  strictRecord(input, "ContextTransition.cause", [
    "kind", "id",
  ], "context_transition_invalid");
  return Object.freeze({
    kind: token(input.kind, "ContextTransition.cause.kind", "context_transition_invalid"),
    id: nullableToken(input.id, "ContextTransition.cause.id", "context_transition_invalid"),
  });
}
