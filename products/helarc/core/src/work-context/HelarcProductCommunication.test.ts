import { describe, expect, it } from "vitest";
import {
  snapshotHelarcCollaborationRecord,
  snapshotHelarcReviewRecord,
  type HelarcAuthorityProjection,
  type HelarcEngineeringReviewRecord,
  type HelarcProposalReviewRecord,
} from "./HelarcProductCommunication.js";

const DECIDED_AT = "2026-08-13T00:00:00.000Z";

describe("Helarc Product communication", () => {
  it("preserves bounded authority state as a projection rather than a grant", () => {
    const projection: HelarcAuthorityProjection = {
      kind: "authority_projection",
      id: "authority-projection-1",
      threadId: "thread-1",
      runId: "run-1",
      authorityRef: recordRef("permission", "authority_resolution", "resolution-1", "1"),
      subjectRef: recordRef("canonical-action", "action_subject", "action-1", "3"),
      state: "resolved",
      summary: "The authority request was resolved; application remains owner-defined.",
      projectedAt: DECIDED_AT,
    };

    const snapshot = snapshotHelarcCollaborationRecord(projection);
    expect(snapshot).toEqual(projection);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).not.toHaveProperty("grant");
    expect(snapshot).not.toHaveProperty("permissions");
  });

  it("keeps proposal intent separate from engineering findings", () => {
    const proposal: HelarcProposalReviewRecord = {
      kind: "proposal_review",
      id: "proposal-review-1",
      threadId: "thread-1",
      runId: "run-1",
      proposalRef: recordRef("helarc", "proposal_revision", "proposal-1", "2"),
      intent: "request_revision",
      actorRef: recordRef("helarc.desktop", "user", "user-1", null),
      reason: "Preserve the existing export.",
      decidedAt: DECIDED_AT,
    };
    const engineering: HelarcEngineeringReviewRecord = {
      kind: "engineering_review",
      id: "engineering-review-1",
      threadId: "thread-1",
      runId: "run-1",
      subjectRef: recordRef("helarc", "artifact", "artifact-1", "1"),
      reviewerRef: recordRef("helarc", "reviewer", "reviewer-1", "1"),
      findings: [{
        id: "finding-1",
        category: "correctness",
        severity: "high",
        summary: "The exported contract no longer matches its consumer.",
        evidenceRefs: [recordRef("context", "evidence", "evidence-1", "1")],
        validationRefs: [],
        uncertainty: ["The downstream package was not executed."],
      }],
      coveredScopes: ["public API"],
      uncoveredScopes: ["runtime behavior"],
      uncertainty: ["Integration tests were unavailable."],
      reportArtifactRef: recordRef("helarc", "artifact", "review-report-1", "1"),
      reviewedAt: DECIDED_AT,
    };

    expect(snapshotHelarcReviewRecord(proposal)).toMatchObject({
      kind: "proposal_review",
      intent: "request_revision",
      proposalRef: { revision: "2" },
    });
    expect(snapshotHelarcReviewRecord(engineering)).toMatchObject({
      kind: "engineering_review",
      findings: [{ severity: "high" }],
      uncoveredScopes: ["runtime behavior"],
    });
  });

  it("rejects unowned metadata and duplicate engineering finding identity", () => {
    const projection = {
      kind: "authority_projection",
      id: "authority-projection-1",
      threadId: "thread-1",
      runId: "run-1",
      authorityRef: recordRef("permission", "authority_resolution", "resolution-1", "1"),
      subjectRef: recordRef("canonical-action", "action_subject", "action-1", "3"),
      state: "resolved",
      summary: "Resolved.",
      projectedAt: DECIDED_AT,
      rawGrant: { fileSystem: ["D:/workspace"] },
    } as unknown as HelarcAuthorityProjection;
    expect(snapshotHelarcCollaborationRecord(projection)).toBeNull();

    const finding = {
      id: "finding-1",
      category: "correctness",
      severity: "medium" as const,
      summary: "Finding.",
      evidenceRefs: [],
      validationRefs: [],
      uncertainty: [],
    };
    expect(snapshotHelarcReviewRecord({
      kind: "engineering_review",
      id: "engineering-review-1",
      threadId: "thread-1",
      runId: null,
      subjectRef: recordRef("helarc", "artifact", "artifact-1", "1"),
      reviewerRef: recordRef("helarc", "reviewer", "reviewer-1", "1"),
      findings: [finding, { ...finding }],
      coveredScopes: [],
      uncoveredScopes: [],
      uncertainty: [],
      reportArtifactRef: null,
      reviewedAt: DECIDED_AT,
    })).toBeNull();
  });
});

function recordRef(
  owner: string,
  kind: string,
  id: string,
  revision: string | null,
) {
  return { owner, kind, id, revision };
}
