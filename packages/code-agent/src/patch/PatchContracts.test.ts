import { describe, expect, it } from "vitest";
import type {
  AcceptedPatchDecision,
  CreatePatchOperation,
  DeletePatchOperation,
  PatchContentReference,
  PatchOperation,
  PatchProposal,
  PatchStatus,
  RejectedPatchDecision,
  UpdatePatchOperation,
} from "./PatchContracts.js";

const originalContent: PatchContentReference = {
  algorithm: "sha256",
  digest: "a".repeat(64),
  byteLength: 12,
};

function createProposal(operation: PatchOperation): PatchProposal {
  return {
    id: "proposal-1",
    runId: "run-1",
    rootName: "code",
    workspaceId: "workspace-1",
    operation,
    summary: "Update greeting",
    rationale: "Keep the example current.",
    createdAt: "2026-06-20T10:00:00.000Z",
    metadata: {},
  };
}

describe("PatchContracts", () => {
  it("represents create, update, and delete operations with distinct shapes", () => {
    const create: CreatePatchOperation = {
      kind: "create",
      path: "src/new.ts",
      proposedContent: "export const value = 1;\n",
    };
    const update: UpdatePatchOperation = {
      kind: "update",
      path: "src/existing.ts",
      originalContent,
      proposedContent: "export const value = 2;\n",
    };
    const remove: DeletePatchOperation = {
      kind: "delete",
      path: "src/old.ts",
      originalContent,
    };

    expect(create).toEqual({
      kind: "create",
      path: "src/new.ts",
      proposedContent: "export const value = 1;\n",
    });
    expect(update.originalContent.algorithm).toBe("sha256");
    expect(remove.originalContent.digest).toHaveLength(64);
  });

  it("represents proposal and review-decision lifecycle states", () => {
    const proposal = createProposal({
      kind: "update",
      path: "src/existing.ts",
      originalContent,
      proposedContent: "export const value = 2;\n",
    });
    const accepted: AcceptedPatchDecision = {
      status: "accepted",
      runId: proposal.runId,
      proposalId: proposal.id,
      reviewId: "review-1",
      pendingVersion: 1,
      submissionId: "submission-1",
      decidedAt: "2026-06-20T10:01:00.000Z",
      metadata: {},
    };
    const rejected: RejectedPatchDecision = {
      status: "rejected",
      runId: proposal.runId,
      proposalId: proposal.id,
      reviewId: "review-1",
      pendingVersion: 1,
      submissionId: "submission-2",
      decidedAt: "2026-06-20T10:01:00.000Z",
      reason: "The change is no longer needed.",
      metadata: {},
    };
    const states: PatchStatus[] = [
      { status: "proposed", proposal },
      { status: "accepted", proposal, decision: accepted },
      { status: "rejected", proposal, decision: rejected },
    ];

    expect(states.map((state) => state.status)).toEqual([
      "proposed",
      "accepted",
      "rejected",
    ]);
    expect(states[2]?.status === "rejected" && states[2].decision.reason).toBe(
      "The change is no longer needed.",
    );
  });
});
