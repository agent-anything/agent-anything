import type {
  ContextContribution,
  ContextContributionRef,
  ContextSourceRef,
} from "../contribution/ContextContribution.js";
import { snapshotContextContribution } from "../contribution/ContextContribution.js";
import {
  fail,
  isoDateTime,
  nullableToken,
  strictRecord,
  token,
} from "../contract/ContextContractValidation.js";
import type {
  ActiveContext,
  ActiveContextItemRef,
  ActiveContextRef,
  RetainedActiveContextItem,
} from "./ActiveContext.js";
import { snapshotActiveContextRef } from "./ActiveContext.js";
import type {
  InvalidateContextOperation,
  ReplaceContextOperation,
} from "./ContextTransition.js";

export interface ContextSourceRevisionRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string | null;
}

export interface ContextRefreshTarget {
  readonly context: ActiveContextRef;
  readonly item: ActiveContextItemRef;
  readonly contribution: ContextContributionRef;
  readonly source: ContextSourceRevisionRef;
}

interface ContextRefreshProposalBase {
  readonly id: string;
  readonly owner: string;
  readonly target: ContextRefreshTarget;
  readonly cause: string;
  readonly correlationId: string | null;
  readonly createdAt: string;
}

export interface ReplaceContextRefreshProposal extends ContextRefreshProposalBase {
  readonly kind: "replace";
  readonly contribution: ContextContribution;
}

export interface InvalidateContextRefreshProposal extends ContextRefreshProposalBase {
  readonly kind: "invalidate";
  readonly reason: string;
}

export type ContextRefreshProposal =
  | ReplaceContextRefreshProposal
  | InvalidateContextRefreshProposal;

export type ContextRefreshOperation =
  | ReplaceContextOperation
  | InvalidateContextOperation;

export function deriveContextRefreshOperation(input: {
  readonly context: ActiveContext;
  readonly proposal: ContextRefreshProposal;
  readonly maxContributionPayloadBytes: number;
}): ContextRefreshOperation {
  const proposal = snapshotContextRefreshProposal(
    input.proposal,
    input.maxContributionPayloadBytes,
  );
  assertContextRef(input.context.ref, proposal.target.context);
  const retained = findRetainedTarget(input.context, proposal.target.item.id);
  assertTargetLineage(retained, proposal);

  if (proposal.kind === "invalidate") {
    return Object.freeze({
      kind: "invalidate",
      item: retained.ref,
      expectedContribution: retained.contribution.ref,
      reason: proposal.reason,
    });
  }

  const replacement = proposal.contribution;
  if (
    retained.contribution.handling.retention !== "current" ||
    replacement.handling.retention !== "current" ||
    retained.contribution.handling.replacementKey === null ||
    replacement.handling.replacementKey !==
      retained.contribution.handling.replacementKey ||
    replacement.source.owner !== retained.contribution.source.owner ||
    replacement.scope.runId !== input.context.ref.runId
  ) {
    conflict(
      "Context refresh replacement must preserve the owner-declared current slot and Run scope.",
      "ContextRefreshProposal.contribution",
    );
  }
  return Object.freeze({
    kind: "replace",
    item: retained.ref,
    expectedContribution: retained.contribution.ref,
    contribution: replacement,
  });
}

export function snapshotContextRefreshProposal(
  input: ContextRefreshProposal,
  maxContributionPayloadBytes: number,
): ContextRefreshProposal {
  strictRecord(input, "ContextRefreshProposal", [
    "id", "kind", "owner", "target", "cause", "correlationId",
    "contribution", "reason", "createdAt",
  ], "context_transition_invalid");
  const base = {
    id: token(input.id, "ContextRefreshProposal.id", "context_transition_invalid"),
    owner: token(input.owner, "ContextRefreshProposal.owner", "context_transition_invalid"),
    target: snapshotTarget(input.target),
    cause: token(input.cause, "ContextRefreshProposal.cause", "context_transition_invalid"),
    correlationId: nullableToken(
      input.correlationId,
      "ContextRefreshProposal.correlationId",
      "context_transition_invalid",
    ),
    createdAt: isoDateTime(
      input.createdAt,
      "ContextRefreshProposal.createdAt",
      "context_transition_invalid",
    ),
  };
  if (input.kind === "replace") {
    strictRecord(input, "ContextRefreshProposal", [
      "id", "kind", "owner", "target", "cause", "correlationId",
      "contribution", "createdAt",
    ], "context_transition_invalid");
    return Object.freeze({
      ...base,
      kind: "replace",
      contribution: snapshotContextContribution(input.contribution, {
        maxPayloadBytes: maxContributionPayloadBytes,
      }),
    });
  }
  if (input.kind === "invalidate") {
    strictRecord(input, "ContextRefreshProposal", [
      "id", "kind", "owner", "target", "cause", "correlationId",
      "reason", "createdAt",
    ], "context_transition_invalid");
    return Object.freeze({
      ...base,
      kind: "invalidate",
      reason: token(
        input.reason,
        "ContextRefreshProposal.reason",
        "context_transition_invalid",
      ),
    });
  }
  return fail(
    "context_transition_invalid",
    "ContextRefreshProposal kind is invalid.",
    "ContextRefreshProposal.kind",
  );
}

function snapshotTarget(input: ContextRefreshTarget): ContextRefreshTarget {
  strictRecord(input, "ContextRefreshProposal.target", [
    "context", "item", "contribution", "source",
  ], "context_transition_invalid");
  strictRecord(input.item, "ContextRefreshProposal.target.item", ["id"], "context_transition_invalid");
  strictRecord(input.contribution, "ContextRefreshProposal.target.contribution", [
    "id", "revision",
  ], "context_transition_invalid");
  strictRecord(input.source, "ContextRefreshProposal.target.source", [
    "owner", "kind", "id", "revision",
  ], "context_transition_invalid");
  return Object.freeze({
    context: snapshotActiveContextRef(input.context, "ContextRefreshProposal.target.context"),
    item: Object.freeze({
      id: token(input.item.id, "ContextRefreshProposal.target.item.id", "context_transition_invalid"),
    }),
    contribution: Object.freeze({
      id: token(input.contribution.id, "ContextRefreshProposal.target.contribution.id", "context_transition_invalid"),
      revision: token(input.contribution.revision, "ContextRefreshProposal.target.contribution.revision", "context_transition_invalid"),
    }),
    source: snapshotSourceRevision(input.source),
  });
}

function snapshotSourceRevision(input: ContextSourceRevisionRef): ContextSourceRevisionRef {
  return Object.freeze({
    owner: token(input.owner, "ContextRefreshProposal.target.source.owner", "context_transition_invalid"),
    kind: token(input.kind, "ContextRefreshProposal.target.source.kind", "context_transition_invalid"),
    id: token(input.id, "ContextRefreshProposal.target.source.id", "context_transition_invalid"),
    revision: nullableToken(
      input.revision,
      "ContextRefreshProposal.target.source.revision",
      "context_transition_invalid",
    ),
  });
}

function assertContextRef(actual: ActiveContextRef, expected: ActiveContextRef): void {
  if (
    actual.id !== expected.id || actual.runId !== expected.runId ||
    actual.version !== expected.version
  ) {
    conflict("Context refresh proposal targets a stale Active Context.", "ContextRefreshProposal.target.context");
  }
}

function findRetainedTarget(
  context: ActiveContext,
  itemId: string,
): RetainedActiveContextItem {
  const item = context.items.find((candidate) => candidate.ref.id === itemId);
  if (
    item === undefined || !("contribution" in item) ||
    item.lifecycle.kind !== "active"
  ) {
    return conflict("Context refresh target is not an active retained item.", "ContextRefreshProposal.target.item");
  }
  return item;
}

function assertTargetLineage(
  retained: RetainedActiveContextItem,
  proposal: ContextRefreshProposal,
): void {
  const actual = retained.contribution;
  const expected = proposal.target;
  if (
    proposal.owner !== actual.source.owner ||
    expected.contribution.id !== actual.ref.id ||
    expected.contribution.revision !== actual.ref.revision ||
    !sameSourceRevision(expected.source, actual.source)
  ) {
    conflict("Context refresh proposal does not match retained owner and source lineage.", "ContextRefreshProposal.target");
  }
}

function sameSourceRevision(
  expected: ContextSourceRevisionRef,
  actual: ContextSourceRef,
): boolean {
  return expected.owner === actual.owner && expected.kind === actual.kind &&
    expected.id === actual.id && expected.revision === actual.revision;
}

function conflict(message: string, path: string): never {
  return fail("context_transition_conflict", message, path);
}
