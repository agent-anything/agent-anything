import type { ContextContributionRef } from "../contribution/ContextContribution.js";
import { fail } from "../contract/ContextContractValidation.js";
import type {
  ActiveContext,
  ActiveContextItem,
  RetainedActiveContextItem,
} from "./ActiveContext.js";
import { snapshotActiveContext } from "./ActiveContext.js";
import type { ContextAdmissionProfile } from "./ContextAdmission.js";
import { admitContextContribution } from "./ContextAdmission.js";
import type { ContextTransition } from "./ContextTransition.js";
import { snapshotContextTransition } from "./ContextTransition.js";

export interface ApplyContextTransitionInput {
  readonly context: ActiveContext;
  readonly transition: ContextTransition;
  readonly admission: ContextAdmissionProfile;
  readonly maxContributionPayloadBytes: number;
}

export function applyContextTransition(
  input: ApplyContextTransitionInput,
): ActiveContext {
  const limits = Object.freeze({
    maxContributionPayloadBytes: input.maxContributionPayloadBytes,
  });
  const current = snapshotActiveContext(input.context, limits);
  const transition = snapshotContextTransition(input.transition, limits);
  assertExactBase(current, transition);
  if (transition.proposer.owner !== input.admission.owner) {
    conflict("Transition proposer is not the admitted owner.", "ContextTransition.proposer.owner");
  }

  const candidate: ActiveContextItem[] = [...current.items];
  for (const operation of transition.operations) {
    switch (operation.kind) {
      case "add": {
        if (candidate.some((item) => item.ref.id === operation.item.id)) {
          conflict("Context item identity already exists.", "ContextTransition.operations.item");
        }
        assertUniqueContribution(candidate, operation.contribution.ref);
        admitContextContribution(operation.contribution, input.admission);
        candidate.push(Object.freeze({
          ref: operation.item,
          contribution: operation.contribution,
          lifecycle: Object.freeze({ kind: "active" as const }),
        }));
        break;
      }
      case "replace": {
        const index = findActiveItem(candidate, operation.item.id, operation.expectedContribution);
        const previous = candidate[index] as RetainedActiveContextItem;
        if (
          previous.contribution.handling.retention !== "current" ||
          operation.contribution.handling.retention !== "current" ||
          previous.contribution.source.owner !== operation.contribution.source.owner ||
          previous.contribution.handling.replacementKey !== operation.contribution.handling.replacementKey
        ) {
          conflict("Context replacement must preserve one owner-declared current slot.", "ContextTransition.operations");
        }
        assertUniqueContribution(candidate, operation.contribution.ref, operation.item.id);
        admitContextContribution(operation.contribution, input.admission);
        candidate[index] = Object.freeze({
          ref: operation.item,
          contribution: operation.contribution,
          lifecycle: Object.freeze({ kind: "active" as const }),
        });
        break;
      }
      case "invalidate": {
        const index = findActiveItem(candidate, operation.item.id, operation.expectedContribution);
        const item = candidate[index] as RetainedActiveContextItem;
        candidate[index] = Object.freeze({
          ...item,
          lifecycle: Object.freeze({
            kind: "invalidated" as const,
            transitionId: transition.id,
            invalidatedAt: transition.createdAt,
            reason: operation.reason,
          }),
        });
        break;
      }
      case "remove": {
        const index = findActiveItem(candidate, operation.item.id, operation.expectedContribution);
        const item = candidate[index] as RetainedActiveContextItem;
        candidate[index] = Object.freeze({
          ref: item.ref,
          contributionRef: item.contribution.ref,
          source: item.contribution.source,
          scope: item.contribution.scope,
          disclosure: item.contribution.disclosure,
          lifecycle: Object.freeze({
            kind: "removed" as const,
            transitionId: transition.id,
            removedAt: transition.createdAt,
            reason: operation.reason,
          }),
        });
        break;
      }
    }
  }
  assertCurrentSlotCardinality(candidate);

  return snapshotActiveContext(Object.freeze({
    ref: Object.freeze({
      id: current.ref.id,
      runId: current.ref.runId,
      version: current.ref.version + 1,
    }),
    previous: current.ref,
    appliedTransitionId: transition.id,
    items: Object.freeze(candidate),
    createdAt: transition.createdAt,
  }), limits);
}

function assertExactBase(current: ActiveContext, transition: ContextTransition): void {
  if (
    transition.base.id !== current.ref.id ||
    transition.base.runId !== current.ref.runId ||
    transition.base.version !== current.ref.version
  ) {
    conflict("ContextTransition base is stale or belongs to another Active Context.", "ContextTransition.base");
  }
}

function findActiveItem(
  items: readonly ActiveContextItem[],
  itemId: string,
  expected: ContextContributionRef,
): number {
  const index = items.findIndex((item) => item.ref.id === itemId);
  if (index < 0) conflict("ContextTransition target item does not exist.", "ContextTransition.operations.item");
  const item = items[index]!;
  if (!("contribution" in item) || item.lifecycle.kind !== "active") {
    conflict("ContextTransition target item is not active.", "ContextTransition.operations.item");
  }
  if (
    item.contribution.ref.id !== expected.id ||
    item.contribution.ref.revision !== expected.revision
  ) {
    conflict("ContextTransition expected Contribution is stale.", "ContextTransition.operations.expectedContribution");
  }
  return index;
}

function assertUniqueContribution(
  items: readonly ActiveContextItem[],
  contribution: ContextContributionRef,
  exceptItemId: string | null = null,
): void {
  if (items.some((item) => {
    if (item.ref.id === exceptItemId) return false;
    const ref = "contribution" in item ? item.contribution.ref : item.contributionRef;
    return ref.id === contribution.id && ref.revision === contribution.revision;
  })) {
    conflict("ContextContribution immutable revision is already retained.", "ContextTransition.operations.contribution.ref");
  }
}

function assertCurrentSlotCardinality(items: readonly ActiveContextItem[]): void {
  const slots = new Set<string>();
  for (const item of items) {
    if (!("contribution" in item) || item.lifecycle.kind !== "active") continue;
    const contribution = item.contribution;
    if (contribution.handling.retention !== "current") continue;
    const slot = `${contribution.source.owner}:${contribution.handling.replacementKey}`;
    if (slots.has(slot)) {
      conflict("Active Context contains more than one item for a current slot.", "ActiveContext.items");
    }
    slots.add(slot);
  }
}

function conflict(message: string, path: string): never {
  return fail("context_transition_conflict", message, path);
}
