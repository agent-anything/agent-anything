import { createHash } from "node:crypto";
import type { WorkspaceIdentity } from "@agent-anything/workspace/identity";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import type {
  CaptureCodeSourceInput,
  CodeSourceCaptureResult,
  CodeSourcePort,
  CodeSourceRehydrationResult,
  CodeSourceSnapshot,
  RehydrateCodeSourceInput,
} from "@agent-anything/helarc-code-agent/source";
import { beforeEach, describe, expect, it } from "vitest";
import {
  acceptPatch,
  createPatchProposal,
  materializePatchReview,
  PatchWorkflowError,
  rejectPatch,
  requestPatchRevision,
  type PatchProposalChange,
  type ProposedPatchStatus,
} from "./index.js";

const timestamp = "2026-06-20T12:00:00.000Z";

describe("PatchWorkflow", () => {
  let source: MemoryCodeSource;

  beforeEach(() => {
    source = new MemoryCodeSource({
      "src/existing.txt": "before\n",
      "src/delete.txt": "remove me\n",
    });
  });

  it("creates and accepts a create proposal without mutating source state", async () => {
    const proposed = await propose({
      kind: "create",
      path: "src/created.txt",
      proposedContent: "created\n",
    });

    expect(proposed.proposal).toMatchObject({
      id: "proposal-1",
      runId: "run-1",
      rootName: "workspace-code",
      workspaceId: "workspace-code",
      operation: { kind: "create", path: "src/created.txt" },
    });
    expect(acceptPatch(proposed, decisionInput())).toMatchObject({
      status: "accepted",
      decision: {
        proposalId: "proposal-1",
        reviewId: "review-1",
        submissionId: "submission-1",
      },
    });
    expect(source.read("src/created.txt")).toBeNull();
  });

  it("captures an update baseline without mutating source state", async () => {
    const proposed = await propose({
      kind: "update",
      path: "src/existing.txt",
      proposedContent: "after\n",
    });

    expect(proposed.proposal.operation).toMatchObject({
      kind: "update",
      originalContent: { algorithm: "sha256", byteLength: 7 },
    });
    if (proposed.proposal.operation.kind !== "update") throw new Error("Expected update operation.");
    expect(proposed.proposal.operation.originalContent.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(acceptPatch(proposed, decisionInput()).status).toBe("accepted");
    expect(source.read("src/existing.txt")).toBe("before\n");
  });

  it("materializes review content only after revalidating the source snapshot", async () => {
    const proposed = await propose({
      kind: "update",
      path: "src/existing.txt",
      proposedContent: "after\n",
    });

    await expect(materializePatchReview({
      patch: proposed,
      workspace: createWorkspaceSelection(),
      source,
      createReviewId: () => "review-1",
    })).resolves.toMatchObject({
      reviewId: "review-1",
      path: "src/existing.txt",
      operation: "update",
      originalContent: "before\n",
      proposedContent: "after\n",
      originalContentBytes: 7,
      proposedContentBytes: 6,
    });
  });

  it("rejects review materialization after the proposal baseline changes", async () => {
    const proposed = await propose({
      kind: "update",
      path: "src/existing.txt",
      proposedContent: "after\n",
    });
    source.write("src/existing.txt", "changed\n");

    await expect(materializePatchReview({
      patch: proposed,
      workspace: createWorkspaceSelection(),
      source,
    })).rejects.toMatchObject({ name: "PatchWorkflowError", code: "patch_stale" });
  });

  it("creates a new immutable revision and prevents an earlier decision from carrying forward", async () => {
    const first = await propose({
      kind: "update",
      path: "src/existing.txt",
      proposedContent: "after\n",
    });
    const second = await createPatchProposal({
      ...proposalInput({
        kind: "update",
        path: "src/existing.txt",
        proposedContent: "revised\n",
      }),
      previousRevision: first.proposal,
    }, proposalOptions());

    expect(second.proposal).toMatchObject({
      id: "proposal-1",
      revision: 2,
      previousRevision: { proposalId: "proposal-1", revision: 1 },
    });
    expect(() => acceptPatch(second, decisionInput())).toThrowError(PatchWorkflowError);
    expect(requestPatchRevision(second, {
      ...decisionInput(),
      proposalRevision: 2,
      reason: "Adjust the implementation.",
    })).toMatchObject({
      status: "revision_requested",
      decision: { proposalRevision: 2, reason: "Adjust the implementation." },
    });
  });

  it("accepts delete and reject decisions without applying either change", async () => {
    const deleted = await propose({ kind: "delete", path: "src/delete.txt" });
    expect(acceptPatch(deleted, decisionInput()).status).toBe("accepted");
    expect(source.read("src/delete.txt")).toBe("remove me\n");

    const updated = await propose({
      kind: "update",
      path: "src/existing.txt",
      proposedContent: "after\n",
    });
    expect(rejectPatch(updated, {
      ...decisionInput(),
      reason: "Keep the existing behavior.",
    })).toMatchObject({
      status: "rejected",
      decision: { reason: "Keep the existing behavior." },
    });
    expect(source.read("src/existing.txt")).toBe("before\n");
  });

  it("maps unsafe source targets to a bounded patch error", async () => {
    await expect(propose({
      kind: "update",
      path: "../outside/secret.txt",
      proposedContent: "changed\n",
    })).rejects.toMatchObject({
      name: "PatchWorkflowError",
      code: "patch_path_unsafe",
    });
  });

  it("rejects malformed persisted source references before review", async () => {
    const proposed = await propose({
      kind: "update",
      path: "src/existing.txt",
      proposedContent: "after\n",
    });
    if (proposed.proposal.operation.kind !== "update") throw new Error("Expected update operation.");
    const malformed: ProposedPatchStatus = {
      ...proposed,
      proposal: {
        ...proposed.proposal,
        sourceSnapshot: {
          ...proposed.proposal.sourceSnapshot,
          contentRef: {
            ...proposed.proposal.sourceSnapshot.contentRef!,
            digest: "not-a-sha256-digest",
          },
        },
      },
    };

    await expect(materializePatchReview({
      patch: malformed,
      workspace: createWorkspaceSelection(),
      source,
    })).rejects.toMatchObject({ code: "patch_state_invalid" });
  });

  it("enforces bounded proposal and review content", async () => {
    await expect(createPatchProposal(proposalInput({
      kind: "create",
      path: "src/large.txt",
      proposedContent: "12345",
    }), { ...proposalOptions(), limits: { maxContentBytes: 4 } }))
      .rejects.toBeInstanceOf(PatchWorkflowError);

    const proposed = await propose({
      kind: "create",
      path: "src/bounded.txt",
      proposedContent: "12345",
    });
    await expect(materializePatchReview({
      patch: proposed,
      workspace: createWorkspaceSelection(),
      source,
      limits: { maxContentBytes: 4 },
    })).rejects.toMatchObject({ code: "patch_state_invalid" });
  });

  function propose(change: PatchProposalChange): Promise<ProposedPatchStatus> {
    return createPatchProposal(proposalInput(change), proposalOptions());
  }

  function proposalInput(change: PatchProposalChange) {
    return {
      runId: "run-1",
      workspace: createWorkspaceSelection(),
      source,
      change,
      producer: { kind: "controller" as const, owner: "helarc", refId: "model-item-1" },
      creationBasis: { kind: "controller_output" as const, refId: "model-item-1" },
      sensitivity: "private" as const,
      summary: "Test patch",
      rationale: "Exercise the patch workflow.",
    };
  }
});

function proposalOptions() {
  return { now: clock, createProposalId: () => "proposal-1" };
}

function decisionInput() {
  return {
    runId: "run-1",
    proposalId: "proposal-1",
    proposalRevision: 1,
    reviewId: "review-1",
    pendingVersion: 1,
    submissionId: "submission-1",
    now: clock,
  };
}

function createWorkspaceSelection(): WorkspaceSelection {
  return { primary: createWorkspace("workspace-code"), additional: [] };
}

function createWorkspace(id: string): WorkspaceIdentity {
  return {
    id,
    name: id,
    rootRef: `memory://${id}`,
    trustState: "trusted",
    source: "test",
    policyRefs: [],
    metadata: {},
  };
}

class MemoryCodeSource implements CodeSourcePort {
  private readonly files = new Map<string, string>();

  constructor(entries: Readonly<Record<string, string>>) {
    for (const [path, content] of Object.entries(entries)) this.files.set(path, content);
  }

  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  write(path: string, content: string): void {
    this.files.set(path, content);
  }

  async capture(input: CaptureCodeSourceInput): Promise<CodeSourceCaptureResult> {
    const path = normalizePath(input.path);
    if (path === null) return sourceFailure("invalid", "code_source_path_outside_workspace", "Path escapes the workspace.");
    const workspace = input.workspace?.primary;
    if (workspace === undefined) return sourceFailure("unavailable", "workspace_required", "Workspace is unavailable.");
    const content = this.files.get(path);
    if (input.operation === "create") {
      if (content !== undefined) return sourceFailure("invalid", "code_source_target_exists", "Create target already exists.");
      return { status: "captured", snapshot: absentSnapshot(workspace.id, path) };
    }
    if (content === undefined) return sourceFailure("invalid", "code_source_target_missing", "Source target is missing.");
    if (Buffer.byteLength(content, "utf8") > input.maxContentBytes) {
      return sourceFailure("invalid", "code_source_content_limit_exceeded", "Source content exceeds its limit.");
    }
    return { status: "captured", snapshot: presentSnapshot(workspace.id, path, content) };
  }

  async rehydrate(input: RehydrateCodeSourceInput): Promise<CodeSourceRehydrationResult> {
    if (!validContentRef(input.expected)) {
      return sourceFailure("invalid", "code_source_snapshot_invalid", "Source snapshot is invalid.");
    }
    const current = await this.capture({
      workspace: input.workspace,
      rootName: input.expected.target.rootName,
      path: input.expected.target.path,
      operation: input.expected.baseline.kind === "absent" ? "create" : "update",
      maxContentBytes: input.maxContentBytes,
    });
    if (current.status !== "captured") return current;
    if (JSON.stringify(snapshotBasis(current.snapshot)) !== JSON.stringify(snapshotBasis(input.expected))) {
      return sourceFailure("changed", "code_source_baseline_changed", "Source baseline changed.");
    }
    return { status: "matched", snapshot: current.snapshot };
  }
}

function absentSnapshot(workspaceId: string, path: string): CodeSourceSnapshot {
  return {
    target: { rootName: workspaceId, workspaceId, path },
    baseline: { kind: "absent" },
    content: null,
    contentRef: null,
    capturedAt: timestamp,
  };
}

function presentSnapshot(workspaceId: string, path: string, content: string): CodeSourceSnapshot {
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  return {
    target: { rootName: workspaceId, workspaceId, path },
    baseline: {
      kind: "present",
      entryKind: "file",
      objectIdentity: { kind: "posix", deviceId: "memory", inode: path },
      contentDigest: digest,
    },
    content,
    contentRef: { algorithm: "sha256", digest, byteLength: Buffer.byteLength(content, "utf8") },
    capturedAt: timestamp,
  };
}

function snapshotBasis(snapshot: CodeSourceSnapshot): unknown {
  return {
    target: snapshot.target,
    baseline: snapshot.baseline,
    contentRef: snapshot.contentRef,
  };
}

function validContentRef(snapshot: CodeSourceSnapshot): boolean {
  return snapshot.contentRef === null || /^sha256:[a-f0-9]{64}$/.test(snapshot.contentRef.digest);
}

function normalizePath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  return normalized.startsWith("/") || normalized.split("/").includes("..") ? null : normalized;
}

function sourceFailure<TStatus extends "changed" | "invalid" | "unavailable" | "failed">(
  status: TStatus,
  code: string,
  message: string,
): { status: TStatus; owner: "helarc.code-workspace"; code: string; message: string } {
  return { status, owner: "helarc.code-workspace", code, message };
}

function clock(): string {
  return timestamp;
}
