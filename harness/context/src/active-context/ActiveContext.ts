import type {
  ContextContribution,
  ContextContributionRef,
  ContextContributionScope,
  ContextDisclosure,
  ContextSourceRef,
} from "../contribution/ContextContribution.js";
import {
  snapshotContextContribution,
  snapshotContextContributionRef,
  snapshotContextDisclosure,
} from "../contribution/ContextContribution.js";
import {
  fail,
  isoDateTime,
  nonNegativeInteger,
  nullableToken,
  strictRecord,
  token,
} from "../contract/ContextContractValidation.js";

export interface ActiveContextRef {
  readonly id: string;
  readonly runId: string;
  readonly version: number;
}

export interface ActiveContextItemRef {
  readonly id: string;
}

export interface ActiveContextItemActive {
  readonly kind: "active";
}

export interface ActiveContextItemInvalidated {
  readonly kind: "invalidated";
  readonly transitionId: string;
  readonly invalidatedAt: string;
  readonly reason: string;
}

export type ActiveContextRetainedLifecycle =
  | ActiveContextItemActive
  | ActiveContextItemInvalidated;

export interface RetainedActiveContextItem {
  readonly ref: ActiveContextItemRef;
  readonly contribution: ContextContribution;
  readonly lifecycle: ActiveContextRetainedLifecycle;
}

export interface RemovedActiveContextItem {
  readonly ref: ActiveContextItemRef;
  readonly contributionRef: ContextContributionRef;
  readonly source: ContextSourceRef;
  readonly scope: ContextContributionScope;
  readonly disclosure: ContextDisclosure;
  readonly lifecycle: {
    readonly kind: "removed";
    readonly transitionId: string;
    readonly removedAt: string;
    readonly reason: string;
  };
}

export type ActiveContextItem =
  | RetainedActiveContextItem
  | RemovedActiveContextItem;

export interface ActiveContext {
  readonly ref: ActiveContextRef;
  readonly previous: ActiveContextRef | null;
  readonly appliedTransitionId: string | null;
  readonly items: readonly ActiveContextItem[];
  readonly createdAt: string;
}

export interface ActiveContextSnapshotLimits {
  readonly maxContributionPayloadBytes: number;
}

export function createEmptyActiveContext(input: {
  readonly id: string;
  readonly runId: string;
  readonly createdAt: string;
}): ActiveContext {
  strictRecord(input, "CreateEmptyActiveContextInput", [
    "id", "runId", "createdAt",
  ]);
  return Object.freeze({
    ref: Object.freeze({
      id: token(input.id, "CreateEmptyActiveContextInput.id"),
      runId: token(input.runId, "CreateEmptyActiveContextInput.runId"),
      version: 0,
    }),
    previous: null,
    appliedTransitionId: null,
    items: Object.freeze([]),
    createdAt: isoDateTime(
      input.createdAt,
      "CreateEmptyActiveContextInput.createdAt",
    ),
  });
}

export function snapshotActiveContextRef(
  input: ActiveContextRef,
  path = "ActiveContextRef",
): ActiveContextRef {
  strictRecord(input, path, ["id", "runId", "version"]);
  return Object.freeze({
    id: token(input.id, `${path}.id`),
    runId: token(input.runId, `${path}.runId`),
    version: nonNegativeInteger(input.version, `${path}.version`),
  });
}

export function snapshotActiveContext(
  input: ActiveContext,
  limits: ActiveContextSnapshotLimits,
): ActiveContext {
  strictRecord(input, "ActiveContext", [
    "ref", "previous", "appliedTransitionId", "items", "createdAt",
  ]);
  strictRecord(limits, "ActiveContextSnapshotLimits", [
    "maxContributionPayloadBytes",
  ]);
  const maxContributionPayloadBytes = nonNegativeInteger(
    limits.maxContributionPayloadBytes,
    "ActiveContextSnapshotLimits.maxContributionPayloadBytes",
  );
  const ref = snapshotActiveContextRef(input.ref, "ActiveContext.ref");
  const previous = input.previous === null
    ? null
    : snapshotActiveContextRef(input.previous, "ActiveContext.previous");
  if (
    (ref.version === 0 && previous !== null) ||
    (ref.version > 0 &&
      (previous === null ||
        previous.id !== ref.id ||
        previous.runId !== ref.runId ||
        previous.version !== ref.version - 1))
  ) {
    fail(
      "context_contract_invalid",
      "ActiveContext previous reference must identify the immediately preceding version.",
      "ActiveContext.previous",
    );
  }
  const appliedTransitionId = nullableToken(
    input.appliedTransitionId,
    "ActiveContext.appliedTransitionId",
  );
  if (
    (ref.version === 0 && appliedTransitionId !== null) ||
    (ref.version > 0 && appliedTransitionId === null)
  ) {
    fail(
      "context_contract_invalid",
      "ActiveContext transition identity must be absent only on version zero.",
      "ActiveContext.appliedTransitionId",
    );
  }
  if (!Array.isArray(input.items)) {
    fail(
      "context_contract_invalid",
      "ActiveContext.items must be an array.",
      "ActiveContext.items",
    );
  }
  const items = input.items.map((item, index) =>
    snapshotActiveContextItem(
      item,
      maxContributionPayloadBytes,
      `ActiveContext.items[${index}]`,
    ),
  );
  if (new Set(items.map((item) => item.ref.id)).size !== items.length) {
    fail(
      "context_contract_invalid",
      "ActiveContext item identities must be unique.",
      "ActiveContext.items",
    );
  }
  for (const item of items) {
    const itemRunId = "contribution" in item
      ? item.contribution.scope.runId
      : item.scope.runId;
    if (itemRunId !== ref.runId) {
      fail(
        "context_contract_invalid",
        "ActiveContext cannot retain a cross-Run Contribution.",
        "ActiveContext.items",
      );
    }
  }
  return Object.freeze({
    ref,
    previous,
    appliedTransitionId,
    items: Object.freeze(items),
    createdAt: isoDateTime(input.createdAt, "ActiveContext.createdAt"),
  });
}

function snapshotActiveContextItem(
  input: ActiveContextItem,
  maxContributionPayloadBytes: number,
  path: string,
): ActiveContextItem {
  if ("contribution" in input) {
    strictRecord(input, path, ["ref", "contribution", "lifecycle"]);
    const ref = snapshotItemRef(input.ref as ActiveContextItemRef, `${path}.ref`);
    const contribution = snapshotContextContribution(
      input.contribution as ContextContribution,
      { maxPayloadBytes: maxContributionPayloadBytes },
    );
    const lifecycle = input.lifecycle as ActiveContextRetainedLifecycle;
    if (lifecycle.kind === "active") {
      strictRecord(input, path, ["ref", "contribution", "lifecycle"]);
      strictRecord(lifecycle, `${path}.lifecycle`, ["kind"]);
      return Object.freeze({
        ref,
        contribution,
        lifecycle: Object.freeze({ kind: "active" }),
      });
    }
    if (lifecycle.kind === "invalidated") {
      strictRecord(lifecycle, `${path}.lifecycle`, [
        "kind", "transitionId", "invalidatedAt", "reason",
      ]);
      return Object.freeze({
        ref,
        contribution,
        lifecycle: Object.freeze({
          kind: "invalidated",
          transitionId: token(
            lifecycle.transitionId,
            `${path}.lifecycle.transitionId`,
          ),
          invalidatedAt: isoDateTime(
            lifecycle.invalidatedAt,
            `${path}.lifecycle.invalidatedAt`,
          ),
          reason: token(lifecycle.reason, `${path}.lifecycle.reason`),
        }),
      });
    }
    return fail(
      "context_contract_invalid",
      "ActiveContext retained item lifecycle is invalid.",
      `${path}.lifecycle.kind`,
    );
  }

  strictRecord(input, path, [
    "ref", "contributionRef", "source", "scope", "disclosure", "lifecycle",
  ]);
  const removed = input as RemovedActiveContextItem;
  const ref = snapshotItemRef(removed.ref, `${path}.ref`);
  strictRecord(removed.lifecycle, `${path}.lifecycle`, [
    "kind", "transitionId", "removedAt", "reason",
  ]);
  if (removed.lifecycle.kind !== "removed") {
    return fail(
      "context_contract_invalid",
      "ActiveContext removed item lifecycle is invalid.",
      `${path}.lifecycle.kind`,
    );
  }
  return Object.freeze({
    ref,
    contributionRef: snapshotContextContributionRef(removed.contributionRef),
    source: snapshotSource(removed.source, `${path}.source`),
    scope: snapshotScope(removed.scope, `${path}.scope`),
    disclosure: snapshotContextDisclosure(removed.disclosure),
    lifecycle: Object.freeze({
      kind: "removed",
      transitionId: token(
        removed.lifecycle.transitionId,
        `${path}.lifecycle.transitionId`,
      ),
      removedAt: isoDateTime(
        removed.lifecycle.removedAt,
        `${path}.lifecycle.removedAt`,
      ),
      reason: token(removed.lifecycle.reason, `${path}.lifecycle.reason`),
    }),
  });
}

function snapshotItemRef(
  input: ActiveContextItemRef,
  path: string,
): ActiveContextItemRef {
  strictRecord(input, path, ["id"]);
  return Object.freeze({ id: token(input.id, `${path}.id`) });
}

function snapshotSource(input: ContextSourceRef, path: string): ContextSourceRef {
  strictRecord(input, path, ["owner", "kind", "id", "revision", "observedAt"]);
  return Object.freeze({
    owner: token(input.owner, `${path}.owner`),
    kind: token(input.kind, `${path}.kind`),
    id: token(input.id, `${path}.id`),
    revision: nullableToken(input.revision, `${path}.revision`),
    observedAt: input.observedAt === null
      ? null
      : isoDateTime(input.observedAt, `${path}.observedAt`),
  });
}

function snapshotScope(
  input: ContextContributionScope,
  path: string,
): ContextContributionScope {
  strictRecord(input, path, ["runId", "ownerScope"]);
  return Object.freeze({
    runId: token(input.runId, `${path}.runId`),
    ownerScope: nullableToken(input.ownerScope, `${path}.ownerScope`),
  });
}
