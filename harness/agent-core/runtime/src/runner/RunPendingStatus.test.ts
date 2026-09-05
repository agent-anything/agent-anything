import { describe, expect, it } from "vitest";
import type { PendingRunSubject } from "../run/index.js";
import { deriveRunStatusAfterPendingChange } from "./RunPendingStatus.js";

describe("pending bookkeeping", () => {
  const children: readonly PendingRunSubject[] = [1, 2].map((id) => ({
    kind: "descendant_run", branchId: `branch-${id}`, required: true,
    openedInRunRevision: id, relationId: `relation-${id}`, childRunId: `child-${id}`,
  }));

  it.each(["suspended", "cancelling", "stopped", "succeeded", "failed", "cancelled"] as const)(
    "does not release %s when Child results remove pending obligations", (status) => {
      for (const count of [2, 1, 0]) {
        expect(deriveRunStatusAfterPendingChange(status, children.slice(0, count))).toBe(status);
      }
    },
  );

  it("derives waiting and running only for a progressing Run", () => {
    expect(deriveRunStatusAfterPendingChange("running", children)).toBe("waiting");
    expect(deriveRunStatusAfterPendingChange("waiting", [])).toBe("running");
  });
});
