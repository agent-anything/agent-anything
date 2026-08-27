import {
  assertDenseArray,
  assertNonEmpty,
  assertStrictRecord,
  snapshotData,
} from "../contract/WorkspaceContractValidation.js";

export type WorkspaceTrustState = "trusted" | "restricted" | "unknown";

export interface WorkspaceIdentity {
  readonly id: string;
  readonly name: string;
  readonly rootRef: string | null;
  readonly trustState: WorkspaceTrustState;
  readonly source: string;
  readonly policyRefs: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function snapshotWorkspaceIdentity(
  workspace: WorkspaceIdentity,
  field = "WorkspaceIdentity",
): WorkspaceIdentity {
  assertStrictRecord(
    workspace,
    field,
    new Set(["id", "name", "rootRef", "trustState", "source", "policyRefs", "metadata"]),
  );
  assertNonEmpty(workspace.id, `${field}.id`);
  assertNonEmpty(workspace.name, `${field}.name`);
  assertNonEmpty(workspace.source, `${field}.source`);
  if (workspace.rootRef !== null) assertNonEmpty(workspace.rootRef, `${field}.rootRef`);
  if (
    workspace.trustState !== "trusted" &&
    workspace.trustState !== "restricted" &&
    workspace.trustState !== "unknown"
  ) {
    throw new TypeError(`${field}.trustState is unsupported.`);
  }
  assertDenseArray(workspace.policyRefs, `${field}.policyRefs`);
  const policyRefs = workspace.policyRefs.map((policyRef, index) => {
    assertNonEmpty(policyRef, `${field}.policyRefs[${index}]`);
    return policyRef;
  });
  if (new Set(policyRefs).size !== policyRefs.length) {
    throw new TypeError(`${field}.policyRefs must be unique.`);
  }
  const metadata = snapshotData(workspace.metadata, `${field}.metadata`);
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new TypeError(`${field}.metadata must be an object.`);
  }
  return Object.freeze({
    id: workspace.id,
    name: workspace.name,
    rootRef: workspace.rootRef,
    trustState: workspace.trustState,
    source: workspace.source,
    policyRefs: Object.freeze(policyRefs),
    metadata: metadata as Readonly<Record<string, unknown>>,
  });
}
