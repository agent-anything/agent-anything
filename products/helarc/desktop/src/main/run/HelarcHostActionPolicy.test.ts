import type { CanonicalActionSubjectRevision } from "@agent-anything/canonical-action/subject";
import { describe, expect, it } from "vitest";
import { createHelarcHostActionPolicy } from "./HelarcHostActionPolicy.js";

describe("Helarc Host Action policy", () => {
  it.each([
    ["ask_for_approval", "review_required"],
    ["approve_for_me", "review_required"],
    ["full_access", "allowed"],
  ] as const)("maps %s file writes to %s", async (permissionPreset, status) => {
    const result = await createHelarcHostActionPolicy({
      permissionPreset,
      now: () => "2026-08-21T00:00:00.000Z",
    }).evaluate({
      checkId: "policy-check-1",
      subject: fileWriteSubject(),
      context: {
        policySnapshotId: "policy-snapshot-1",
        workspaceTrustState: "trusted",
        identityId: "identity-1",
        environmentId: "environment-1",
        metadata: {},
      },
    });
    expect(result.status).toBe(status);
  });
});

function fileWriteSubject(): CanonicalActionSubjectRevision {
  return {
    ref: { action: { id: "action-1" }, revision: 1 },
    effects: [{
      schemaVersion: 1,
      kind: "file_system",
      operation: "write",
      targets: [{}],
    }],
  } as unknown as CanonicalActionSubjectRevision;
}
