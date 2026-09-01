import {
  createDelegationContractIdentity,
  deepFreeze,
  isoDateTime,
  snapshotTokenList,
  strictRecord,
  token,
} from "./DelegationContract.js";

export type DelegationAuthorityDimensionKind =
  | "workspace"
  | "tool"
  | "permission"
  | "action_execution"
  | "sandbox"
  | "verification"
  | "disclosure"
  | "resource";

export type DelegationAuthoritySourceRole =
  | "root"
  | "parent"
  | "current_policy"
  | "delegation_restriction";

export interface DelegationAuthoritySourceRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string;
}

export interface DelegationAuthorityDimensionInput {
  readonly kind: DelegationAuthorityDimensionKind;
  readonly allowed: readonly string[];
  readonly required: readonly string[];
}

export interface DelegationAuthoritySourceInput {
  readonly role: DelegationAuthoritySourceRole;
  readonly ref: DelegationAuthoritySourceRef;
  readonly dimensions: readonly DelegationAuthorityDimensionInput[];
  readonly deadlineAt: string;
}

export interface DelegationAuthorityDimension
  extends DelegationAuthorityDimensionInput {
  readonly revision: string;
}

export interface DelegationAuthoritySource {
  readonly role: DelegationAuthoritySourceRole;
  readonly ref: DelegationAuthoritySourceRef;
  readonly dimensions: readonly DelegationAuthorityDimension[];
  readonly deadlineAt: string;
  readonly revision: string;
}

export interface DelegationAuthorityDerivationRef {
  readonly id: string;
  readonly revision: string;
}

export interface DelegationAuthorityDerivation {
  readonly schemaVersion: 1;
  readonly ref: DelegationAuthorityDerivationRef;
  readonly sources: readonly DelegationAuthoritySource[];
  readonly effective: readonly DelegationAuthorityDimension[];
  readonly deadlineAt: string;
}

const dimensionKinds: readonly DelegationAuthorityDimensionKind[] = [
  "workspace",
  "tool",
  "permission",
  "action_execution",
  "sandbox",
  "verification",
  "disclosure",
  "resource",
];

const sourceRoles: readonly DelegationAuthoritySourceRole[] = [
  "root",
  "parent",
  "current_policy",
  "delegation_restriction",
];

const requiredSourceRoles: readonly DelegationAuthoritySourceRole[] = [
  "root",
  "parent",
  "current_policy",
];

export function deriveDelegationAuthority(input: {
  readonly derivationId: string;
  readonly sources: readonly DelegationAuthoritySourceInput[];
}): DelegationAuthorityDerivation {
  strictRecord(input, "DelegationAuthorityDerivationInput", [
    "derivationId",
    "sources",
  ]);
  const derivationId = token(input.derivationId, "derivationId");
  if (!Array.isArray(input.sources)) {
    throw new TypeError("Delegation authority sources must be an array.");
  }
  const sources = input.sources.map(snapshotSource);
  const roles = sources.map((source) => source.role);
  if (
    new Set(roles).size !== roles.length ||
    requiredSourceRoles.some((role) => !roles.includes(role)) ||
    roles.some((role) => !sourceRoles.includes(role))
  ) {
    throw new TypeError(
      "Delegation authority requires unique root, parent, and current-policy sources plus at most one restriction.",
    );
  }
  sources.sort((left, right) => sourceRoles.indexOf(left.role) - sourceRoles.indexOf(right.role));

  const effective = dimensionKinds.map((kind) => {
    const dimensions = sources.map((source) =>
      source.dimensions.find((dimension) => dimension.kind === kind)!,
    );
    const allowed = dimensions
      .slice(1)
      .reduce(
        (current, dimension) => current.filter((value) => dimension.allowed.includes(value)),
        [...dimensions[0]!.allowed],
      );
    const required = [...new Set(dimensions.flatMap((dimension) => dimension.required))]
      .sort(compareStrings);
    return createDimension({ kind, allowed, required });
  });
  const deadlineAt = sources
    .map((source) => source.deadlineAt)
    .reduce((earliest, candidate) => candidate < earliest ? candidate : earliest);
  const material = deepFreeze({
    sources,
    effective,
    deadlineAt,
  });
  const revision = createDelegationContractIdentity(
    "agent-anything.delegation-authority-derivation.v1",
    material,
  );
  return deepFreeze({
    schemaVersion: 1 as const,
    ref: { id: derivationId, revision },
    ...material,
  });
}

export function snapshotDelegationAuthorityDerivation(
  input: DelegationAuthorityDerivation,
): DelegationAuthorityDerivation {
  strictRecord(input, "DelegationAuthorityDerivation", [
    "schemaVersion",
    "ref",
    "sources",
    "effective",
    "deadlineAt",
  ]);
  if (input.schemaVersion !== 1) {
    throw new TypeError("Delegation authority must use schema version 1.");
  }
  strictRecord(input.ref, "DelegationAuthorityDerivation.ref", ["id", "revision"]);
  const derived = deriveDelegationAuthority({
    derivationId: token(input.ref.id, "DelegationAuthorityDerivation.ref.id"),
    sources: input.sources.map((source) => ({
      role: source.role,
      ref: source.ref,
      dimensions: source.dimensions.map(({ kind, allowed, required }) => ({
        kind,
        allowed,
        required,
      })),
      deadlineAt: source.deadlineAt,
    })),
  });
  if (token(input.ref.revision, "DelegationAuthorityDerivation.ref.revision") !== derived.ref.revision) {
    throw new TypeError("Delegation authority revision does not match its immutable content.");
  }
  if (
    createDelegationContractIdentity(
      "agent-anything.delegation-authority-effective.v1",
      input.effective,
    ) !==
      createDelegationContractIdentity(
        "agent-anything.delegation-authority-effective.v1",
        derived.effective,
      ) ||
    isoDateTime(input.deadlineAt, "DelegationAuthorityDerivation.deadlineAt") !== derived.deadlineAt
  ) {
    throw new TypeError("Delegation authority effective result is inconsistent with its sources.");
  }
  return derived;
}

export function snapshotDelegationAuthorityDimensions(
  input: readonly (DelegationAuthorityDimensionInput | DelegationAuthorityDimension)[],
): readonly DelegationAuthorityDimension[] {
  if (!Array.isArray(input) || input.length !== dimensionKinds.length) {
    throw new TypeError("Delegation authority requires every dimension.");
  }
  const dimensions = input.map(createDimension);
  const kinds = dimensions.map((dimension) => dimension.kind);
  if (new Set(kinds).size !== dimensionKinds.length || dimensionKinds.some((kind) => !kinds.includes(kind))) {
    throw new TypeError("Delegation authority dimensions must be complete and unique.");
  }
  dimensions.sort((left, right) => dimensionKinds.indexOf(left.kind) - dimensionKinds.indexOf(right.kind));
  return Object.freeze(dimensions);
}

function snapshotSource(
  input: DelegationAuthoritySourceInput,
): DelegationAuthoritySource {
  strictRecord(input, "DelegationAuthoritySource", [
    "role",
    "ref",
    "dimensions",
    "deadlineAt",
  ]);
  if (!sourceRoles.includes(input.role)) {
    throw new TypeError("Delegation authority source role is unsupported.");
  }
  const ref = snapshotSourceRef(input.ref);
  const dimensions = snapshotDelegationAuthorityDimensions(input.dimensions);
  const deadlineAt = isoDateTime(input.deadlineAt, "DelegationAuthoritySource.deadlineAt");
  const material = deepFreeze({ role: input.role, ref, dimensions, deadlineAt });
  return deepFreeze({
    ...material,
    revision: createDelegationContractIdentity(
      "agent-anything.delegation-authority-source.v1",
      material,
    ),
  });
}

function createDimension(
  input: DelegationAuthorityDimensionInput | DelegationAuthorityDimension,
): DelegationAuthorityDimension {
  const hasRevision = "revision" in input;
  strictRecord(
    input,
    "DelegationAuthorityDimension",
    hasRevision ? ["kind", "allowed", "required", "revision"] : ["kind", "allowed", "required"],
  );
  if (!dimensionKinds.includes(input.kind)) {
    throw new TypeError("Delegation authority dimension kind is unsupported.");
  }
  const material = deepFreeze({
    kind: input.kind,
    allowed: snapshotTokenList(input.allowed, `${input.kind}.allowed`),
    required: snapshotTokenList(input.required, `${input.kind}.required`),
  });
  const revision = createDelegationContractIdentity(
    "agent-anything.delegation-authority-dimension.v1",
    material,
  );
  if (hasRevision && token(input.revision, "DelegationAuthorityDimension.revision") !== revision) {
    throw new TypeError("Delegation authority-dimension revision does not match its content.");
  }
  return deepFreeze({
    ...material,
    revision,
  });
}

function snapshotSourceRef(
  input: DelegationAuthoritySourceRef,
): DelegationAuthoritySourceRef {
  strictRecord(input, "DelegationAuthoritySourceRef", [
    "owner",
    "kind",
    "id",
    "revision",
  ]);
  return Object.freeze({
    owner: token(input.owner, "authority source owner"),
    kind: token(input.kind, "authority source kind"),
    id: token(input.id, "authority source id"),
    revision: token(input.revision, "authority source revision"),
  });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
