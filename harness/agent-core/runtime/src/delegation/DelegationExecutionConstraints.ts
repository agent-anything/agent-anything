import {
  createDelegationContractIdentity,
  deepFreeze,
  isoDateTime,
  snapshotTokenList,
  strictRecord,
  token,
} from "./DelegationContract.js";

export type DelegationExecutionConstraintKind =
  | "workspace"
  | "tool"
  | "permission"
  | "action_execution"
  | "sandbox"
  | "disclosure"
  | "resource";

export type DelegationExecutionConstraintSourceRole =
  | "root"
  | "parent"
  | "current_policy"
  | "delegation_restriction";

export interface DelegationExecutionConstraintSourceRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string;
}

export interface DelegationExecutionConstraintInput {
  readonly kind: DelegationExecutionConstraintKind;
  readonly allowed: readonly string[];
  readonly required: readonly string[];
}

export interface DelegationExecutionConstraintSourceInput {
  readonly role: DelegationExecutionConstraintSourceRole;
  readonly ref: DelegationExecutionConstraintSourceRef;
  readonly dimensions: readonly DelegationExecutionConstraintInput[];
  readonly deadlineAt: string;
}

export interface DelegationExecutionConstraint
  extends DelegationExecutionConstraintInput {
  readonly revision: string;
}

export interface DelegationExecutionConstraintSource {
  readonly role: DelegationExecutionConstraintSourceRole;
  readonly ref: DelegationExecutionConstraintSourceRef;
  readonly dimensions: readonly DelegationExecutionConstraint[];
  readonly deadlineAt: string;
  readonly revision: string;
}

export interface DelegationExecutionConstraintsRef {
  readonly id: string;
  readonly revision: string;
}

export interface DelegationExecutionConstraints {
  readonly schemaVersion: 1;
  readonly ref: DelegationExecutionConstraintsRef;
  readonly sources: readonly DelegationExecutionConstraintSource[];
  readonly effective: readonly DelegationExecutionConstraint[];
  readonly deadlineAt: string;
}

const dimensionKinds: readonly DelegationExecutionConstraintKind[] = [
  "workspace",
  "tool",
  "permission",
  "action_execution",
  "sandbox",
  "disclosure",
  "resource",
];

const sourceRoles: readonly DelegationExecutionConstraintSourceRole[] = [
  "root",
  "parent",
  "current_policy",
  "delegation_restriction",
];

const requiredSourceRoles: readonly DelegationExecutionConstraintSourceRole[] = [
  "root",
  "parent",
  "current_policy",
];

export function deriveDelegationExecutionConstraints(input: {
  readonly derivationId: string;
  readonly sources: readonly DelegationExecutionConstraintSourceInput[];
}): DelegationExecutionConstraints {
  strictRecord(input, "DelegationExecutionConstraintInput", [
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

export function snapshotDelegationExecutionConstraints(
  input: DelegationExecutionConstraints,
): DelegationExecutionConstraints {
  strictRecord(input, "DelegationExecutionConstraints", [
    "schemaVersion",
    "ref",
    "sources",
    "effective",
    "deadlineAt",
  ]);
  if (input.schemaVersion !== 1) {
    throw new TypeError("Delegation authority must use schema version 1.");
  }
  strictRecord(input.ref, "DelegationExecutionConstraints.ref", ["id", "revision"]);
  const derived = deriveDelegationExecutionConstraints({
    derivationId: token(input.ref.id, "DelegationExecutionConstraints.ref.id"),
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
  if (token(input.ref.revision, "DelegationExecutionConstraints.ref.revision") !== derived.ref.revision) {
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
    isoDateTime(input.deadlineAt, "DelegationExecutionConstraints.deadlineAt") !== derived.deadlineAt
  ) {
    throw new TypeError("Delegation authority effective result is inconsistent with its sources.");
  }
  return derived;
}

export function snapshotDelegationExecutionConstraintDimensions(
  input: readonly (DelegationExecutionConstraintInput | DelegationExecutionConstraint)[],
): readonly DelegationExecutionConstraint[] {
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
  input: DelegationExecutionConstraintSourceInput,
): DelegationExecutionConstraintSource {
  strictRecord(input, "DelegationExecutionConstraintSource", [
    "role",
    "ref",
    "dimensions",
    "deadlineAt",
  ]);
  if (!sourceRoles.includes(input.role)) {
    throw new TypeError("Delegation authority source role is unsupported.");
  }
  const ref = snapshotSourceRef(input.ref);
  const dimensions = snapshotDelegationExecutionConstraintDimensions(input.dimensions);
  const deadlineAt = isoDateTime(input.deadlineAt, "DelegationConstraintSource.deadlineAt");
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
  input: DelegationExecutionConstraintInput | DelegationExecutionConstraint,
): DelegationExecutionConstraint {
  const hasRevision = "revision" in input;
  strictRecord(
    input,
    "DelegationExecutionConstraint",
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
  if (hasRevision && token(input.revision, "DelegationConstraintDimension.revision") !== revision) {
    throw new TypeError("Delegation authority-dimension revision does not match its content.");
  }
  return deepFreeze({
    ...material,
    revision,
  });
}

function snapshotSourceRef(
  input: DelegationExecutionConstraintSourceRef,
): DelegationExecutionConstraintSourceRef {
  strictRecord(input, "DelegationExecutionConstraintSourceRef", [
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
