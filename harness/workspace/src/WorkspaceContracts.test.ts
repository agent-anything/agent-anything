import { describe, expect, it } from "vitest";
import { snapshotWorkspaceIdentity } from "./identity/index.js";
import { snapshotWorkspaceSelection } from "./selection/index.js";

function identity(id: string) {
  return {
    id,
    name: id,
    rootRef: `opaque://${id}`,
    trustState: "trusted" as const,
    source: "test",
    policyRefs: [],
    metadata: { nested: { value: true } },
  };
}

describe("Workspace contracts", () => {
  it("creates immutable exact identity snapshots", () => {
    const snapshot = snapshotWorkspaceIdentity(identity("primary"));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.metadata.nested)).toBe(true);
    expect(() => snapshotWorkspaceIdentity({ ...identity("x"), extra: true } as never))
      .toThrow(/unsupported/);
  });

  it("rejects duplicate selected Workspace identities", () => {
    expect(() => snapshotWorkspaceSelection({
      primary: identity("same"),
      additional: [identity("same")],
    })).toThrow(/duplicate Workspace id/);
  });
});
