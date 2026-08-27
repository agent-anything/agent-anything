import type { WorkspaceIdentity } from "../identity/index.js";
import { snapshotWorkspaceIdentity } from "../identity/index.js";
import { assertDenseArray, assertStrictRecord } from "../contract/WorkspaceContractValidation.js";

export interface WorkspaceSelection {
  readonly primary: WorkspaceIdentity;
  readonly additional: readonly WorkspaceIdentity[];
}

export function snapshotWorkspaceSelection(selection: WorkspaceSelection): WorkspaceSelection {
  assertStrictRecord(selection, "WorkspaceSelection", new Set(["primary", "additional"]));
  assertDenseArray(selection.additional, "WorkspaceSelection.additional");
  const primary = snapshotWorkspaceIdentity(selection.primary, "WorkspaceSelection.primary");
  const ids = new Set([primary.id]);
  const additional = selection.additional.map((workspace, index) => {
    const snapshot = snapshotWorkspaceIdentity(
      workspace,
      `WorkspaceSelection.additional[${index}]`,
    );
    if (ids.has(snapshot.id)) {
      throw new TypeError(`WorkspaceSelection contains duplicate Workspace id '${snapshot.id}'.`);
    }
    ids.add(snapshot.id);
    return snapshot;
  });
  return Object.freeze({ primary, additional: Object.freeze(additional) });
}

export function listSelectedWorkspaces(
  selection: WorkspaceSelection,
): readonly WorkspaceIdentity[] {
  return Object.freeze([selection.primary, ...selection.additional]);
}

export function findSelectedWorkspace(
  selection: WorkspaceSelection,
  workspaceId: string,
): WorkspaceIdentity | undefined {
  return selection.primary.id === workspaceId
    ? selection.primary
    : selection.additional.find((workspace) => workspace.id === workspaceId);
}
