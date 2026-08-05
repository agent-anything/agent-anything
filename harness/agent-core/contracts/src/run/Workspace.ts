import {
  assertMetadata,
  assertNonEmpty,
  assertRecord,
  snapshotMetadata,
} from "../validation.js";

export type WorkspaceTrustState = "trusted" | "restricted" | "unknown";

export interface WorkspaceContext {
  readonly id: string;
  readonly name: string;
  readonly rootRef: string | null;
  readonly trustState: WorkspaceTrustState;
  readonly source: string;
  readonly policyRefs: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RunWorkspace {
  readonly primary: WorkspaceContext;
  readonly additional: readonly WorkspaceContext[];
}

export function snapshotWorkspaceContext(
  workspace: WorkspaceContext,
  field = "WorkspaceContext",
): WorkspaceContext {
  assertRecord(workspace, field);
  assertNonEmpty(workspace.id, `${field}.id`);
  assertNonEmpty(workspace.name, `${field}.name`);
  assertNonEmpty(workspace.source, `${field}.source`);
  if (workspace.rootRef !== null && typeof workspace.rootRef !== "string") {
    throw new TypeError(`${field}.rootRef must be text or null.`);
  }
  if (
    workspace.trustState !== "trusted" &&
    workspace.trustState !== "restricted" &&
    workspace.trustState !== "unknown"
  ) {
    throw new TypeError(`${field}.trustState is unsupported.`);
  }
  if (!Array.isArray(workspace.policyRefs)) {
    throw new TypeError(`${field}.policyRefs must be an array.`);
  }
  const policyRefs = workspace.policyRefs.map((policyRef, index) => {
    assertNonEmpty(policyRef, `${field}.policyRefs[${index}]`);
    return policyRef;
  });
  if (new Set(policyRefs).size !== policyRefs.length) {
    throw new TypeError(`${field}.policyRefs must be unique.`);
  }
  assertMetadata(workspace.metadata, `${field}.metadata`);

  return Object.freeze({
    id: workspace.id,
    name: workspace.name,
    rootRef: workspace.rootRef,
    trustState: workspace.trustState,
    source: workspace.source,
    policyRefs: Object.freeze(policyRefs),
    metadata: snapshotMetadata(workspace.metadata),
  });
}

export function snapshotRunWorkspace(
  workspace: RunWorkspace,
): RunWorkspace {
  assertRecord(workspace, "RunWorkspace");
  if (!Array.isArray(workspace.additional)) {
    throw new TypeError("RunWorkspace.additional must be an array.");
  }

  const primary = snapshotWorkspaceContext(
    workspace.primary,
    "RunWorkspace.primary",
  );
  const ids = new Set([primary.id]);
  const additional = workspace.additional.map((candidate, index) => {
    const snapshot = snapshotWorkspaceContext(
      candidate,
      `RunWorkspace.additional[${index}]`,
    );
    if (ids.has(snapshot.id)) {
      throw new TypeError(
        `RunWorkspace contains duplicate workspace id '${snapshot.id}'.`,
      );
    }
    ids.add(snapshot.id);
    return snapshot;
  });

  return Object.freeze({
    primary,
    additional: Object.freeze(additional),
  });
}

export function listRunWorkspaces(
  workspace: RunWorkspace,
): readonly WorkspaceContext[] {
  return Object.freeze([workspace.primary, ...workspace.additional]);
}

export function findRunWorkspace(
  workspace: RunWorkspace,
  workspaceId: string,
): WorkspaceContext | undefined {
  return workspace.primary.id === workspaceId
    ? workspace.primary
    : workspace.additional.find((candidate) => candidate.id === workspaceId);
}
