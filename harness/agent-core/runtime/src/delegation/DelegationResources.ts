import type { DelegationLimits } from "./DelegationRequest.js";
import { createDelegationLimits, snapshotDelegationLimits } from "./DelegationRequest.js";
import {
  createDelegationContractIdentity,
  deepFreeze,
  strictRecord,
  token,
} from "./DelegationContract.js";

export type DelegationLimitSourceRole =
  | "root"
  | "parent"
  | "child_agent"
  | "request"
  | "current_policy";

export interface DelegationLimitSourceRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string;
}

export interface DelegationLimitSourceInput {
  readonly role: DelegationLimitSourceRole;
  readonly ref: DelegationLimitSourceRef;
  readonly ceiling: DelegationLimits;
}

export interface DelegationLimitSource extends DelegationLimitSourceInput {
  readonly revision: string;
}

export interface DelegationLimitDerivationRef {
  readonly id: string;
  readonly revision: string;
}

export interface DelegationLimitDerivation {
  readonly schemaVersion: 1;
  readonly ref: DelegationLimitDerivationRef;
  readonly sources: readonly DelegationLimitSource[];
  readonly effective: DelegationLimits;
}

const sourceRoles: readonly DelegationLimitSourceRole[] = [
  "root",
  "parent",
  "child_agent",
  "request",
  "current_policy",
];

export function deriveDelegationLimits(input: {
  readonly derivationId: string;
  readonly sources: readonly DelegationLimitSourceInput[];
}): DelegationLimitDerivation {
  strictRecord(input, "DelegationLimitDerivationInput", ["derivationId", "sources"]);
  const derivationId = token(input.derivationId, "derivationId");
  if (!Array.isArray(input.sources) || input.sources.length !== sourceRoles.length) {
    throw new TypeError("Delegation limits require every exact source role.");
  }
  const sources = input.sources.map(snapshotSource);
  const roles = sources.map((source) => source.role);
  if (new Set(roles).size !== sourceRoles.length || sourceRoles.some((role) => !roles.includes(role))) {
    throw new TypeError("Delegation limit source roles must be complete and unique.");
  }
  sources.sort((left, right) => sourceRoles.indexOf(left.role) - sourceRoles.indexOf(right.role));
  const effective = createDelegationLimits({
    maxControllerTurns: minimum(sources, "maxControllerTurns"),
    maxActions: minimum(sources, "maxActions"),
    maxModelInputTokens: minimum(sources, "maxModelInputTokens"),
    maxModelOutputTokens: minimum(sources, "maxModelOutputTokens"),
    maxCostUnits: minimum(sources, "maxCostUnits"),
    maxDurationMs: minimum(sources, "maxDurationMs"),
    maxContextBytes: minimum(sources, "maxContextBytes"),
    maxResultBytes: minimum(sources, "maxResultBytes"),
  });
  const material = deepFreeze({ sources, effective });
  const revision = createDelegationContractIdentity(
    "agent-anything.delegation-limit-derivation.v1",
    material,
  );
  return deepFreeze({
    schemaVersion: 1 as const,
    ref: { id: derivationId, revision },
    ...material,
  });
}

export function snapshotDelegationLimitDerivation(
  input: DelegationLimitDerivation,
): DelegationLimitDerivation {
  strictRecord(input, "DelegationLimitDerivation", [
    "schemaVersion",
    "ref",
    "sources",
    "effective",
  ]);
  if (input.schemaVersion !== 1) {
    throw new TypeError("Delegation limit derivation must use schema version 1.");
  }
  strictRecord(input.ref, "DelegationLimitDerivation.ref", ["id", "revision"]);
  const derived = deriveDelegationLimits({
    derivationId: token(input.ref.id, "DelegationLimitDerivation.ref.id"),
    sources: input.sources.map((source) => ({
      role: source.role,
      ref: source.ref,
      ceiling: source.ceiling,
    })),
  });
  if (token(input.ref.revision, "DelegationLimitDerivation.ref.revision") !== derived.ref.revision) {
    throw new TypeError("Delegation limit derivation revision does not match its content.");
  }
  if (snapshotDelegationLimits(input.effective).revision !== derived.effective.revision) {
    throw new TypeError("Delegation effective limits are inconsistent with their sources.");
  }
  return derived;
}

function snapshotSource(input: DelegationLimitSourceInput): DelegationLimitSource {
  strictRecord(input, "DelegationLimitSource", ["role", "ref", "ceiling"]);
  if (!sourceRoles.includes(input.role)) {
    throw new TypeError("Delegation limit source role is unsupported.");
  }
  const ref = snapshotSourceRef(input.ref);
  const ceiling = snapshotDelegationLimits(input.ceiling);
  const material = deepFreeze({ role: input.role, ref, ceiling });
  return deepFreeze({
    ...material,
    revision: createDelegationContractIdentity(
      "agent-anything.delegation-limit-source.v1",
      material,
    ),
  });
}

function snapshotSourceRef(input: DelegationLimitSourceRef): DelegationLimitSourceRef {
  strictRecord(input, "DelegationLimitSourceRef", ["owner", "kind", "id", "revision"]);
  return Object.freeze({
    owner: token(input.owner, "limit source owner"),
    kind: token(input.kind, "limit source kind"),
    id: token(input.id, "limit source id"),
    revision: token(input.revision, "limit source revision"),
  });
}

function minimum(
  sources: readonly DelegationLimitSource[],
  field: keyof Omit<DelegationLimits, "revision">,
): number {
  return Math.min(...sources.map((source) => source.ceiling[field]));
}
