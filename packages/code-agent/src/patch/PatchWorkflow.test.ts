import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskWorkspaceScope } from "@agent-anything/agent-core";
import type { WorkspaceContext } from "@agent-anything/governance";
import {
  acceptPatch,
  createPatchProposal,
  materializePatchReview,
  PatchWorkflowError,
  rejectPatch,
  type PatchProposalChange,
  type ProposedPatchStatus,
} from "./index.js";

const timestamp = "2026-06-20T12:00:00.000Z";

describe("PatchWorkflow", () => {
  let testRoot: string;
  let codeRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "agent-anything-patch-"));
    codeRoot = join(testRoot, "code");
    outsideRoot = join(testRoot, "outside");
    await mkdir(join(codeRoot, "src"), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(join(codeRoot, "src", "existing.txt"), "before\n");
    await writeFile(join(codeRoot, "src", "delete.txt"), "remove me\n");
    await writeFile(join(outsideRoot, "secret.txt"), "outside\n");
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("creates and accepts a create proposal without mutating the workspace", async () => {
    const proposed = await propose({
      kind: "create",
      path: join("src", "created.txt"),
      proposedContent: "created\n",
    });

    expect(proposed.proposal).toMatchObject({
      id: "patch-1",
      rootName: "code",
      workspaceId: "workspace-code",
      operation: {
        kind: "create",
        path: "src/created.txt",
      },
    });
    const accepted = acceptPatch(proposed, { now: clock });

    expect(accepted).toMatchObject({ status: "accepted", decision: { patchId: "patch-1" } });
    await expect(readFile(join(codeRoot, "src", "created.txt"), "utf8")).rejects.toThrow();
  });

  it("captures a trusted update baseline without mutating the workspace", async () => {
    const proposed = await propose({
      kind: "update",
      path: join("src", "existing.txt"),
      proposedContent: "after\n",
    });

    expect(proposed.proposal.operation).toMatchObject({
      kind: "update",
      originalContent: {
        algorithm: "sha256",
        byteLength: 7,
      },
    });
    if (proposed.proposal.operation.kind !== "update") {
      throw new Error("Expected update operation.");
    }
    expect(proposed.proposal.operation.originalContent.digest).toHaveLength(64);

    expect(acceptPatch(proposed, { now: clock }).status).toBe("accepted");
    await expect(readFile(join(codeRoot, "src", "existing.txt"), "utf8"))
      .resolves.toBe("before\n");
  });

  it("materializes verified update review content", async () => {
    const proposed = await propose({
      kind: "update",
      path: join("src", "existing.txt"),
      proposedContent: "after\n",
    });

    const review = await materializePatchReview({
      patch: proposed,
      workspaceScope: createScope(),
    });

    expect(review).toMatchObject({
      patchId: "patch-1",
      rootName: "code",
      workspaceId: "workspace-code",
      path: "src/existing.txt",
      operation: "update",
      summary: "Test patch",
      rationale: "Exercise the patch workflow.",
      originalContent: "before\n",
      proposedContent: "after\n",
      originalContentBytes: 7,
      proposedContentBytes: 6,
    });
  });

  it("rejects stale review materialization", async () => {
    const proposed = await propose({
      kind: "update",
      path: join("src", "existing.txt"),
      proposedContent: "after\n",
    });
    await writeFile(join(codeRoot, "src", "existing.txt"), "changed\n");

    await expect(materializePatchReview({
      patch: proposed,
      workspaceScope: createScope(),
    })).rejects.toMatchObject({
      name: "PatchWorkflowError",
      code: "patch_stale",
    });
  });

  it("accepts a delete proposal without mutating the workspace", async () => {
    const proposed = await propose({
      kind: "delete",
      path: join("src", "delete.txt"),
    });

    expect(proposed.proposal.operation).toMatchObject({
      kind: "delete",
      originalContent: { algorithm: "sha256", byteLength: 10 },
    });
    expect(acceptPatch(proposed, { now: clock }).status).toBe("accepted");
    await expect(readFile(join(codeRoot, "src", "delete.txt"), "utf8"))
      .resolves.toBe("remove me\n");
  });

  it("rejects a proposal without touching the target file", async () => {
    const proposed = await propose({
      kind: "update",
      path: join("src", "existing.txt"),
      proposedContent: "after\n",
    });
    const rejected = rejectPatch(proposed, {
      reason: "Keep the existing behavior.",
      now: clock,
    });

    expect(rejected).toMatchObject({
      status: "rejected",
      decision: { patchId: "patch-1", reason: "Keep the existing behavior." },
    });
    await expect(readFile(join(codeRoot, "src", "existing.txt"), "utf8"))
      .resolves.toBe("before\n");
  });

  it("rejects lexical escapes and final-target symbolic links", async () => {
    await expect(propose({
      kind: "update",
      path: join("..", "outside", "secret.txt"),
      proposedContent: "changed\n",
    })).rejects.toMatchObject({
      name: "PatchWorkflowError",
      code: "patch_path_unsafe",
    });

    const linkPath = join(codeRoot, "src", "linked.txt");
    const linkCreated = await tryCreateSymlink(
      join(codeRoot, "src", "existing.txt"),
      linkPath,
    );

    if (linkCreated) {
      await expect(propose({
        kind: "delete",
        path: join("src", "linked.txt"),
      })).rejects.toMatchObject({
        name: "PatchWorkflowError",
        code: "patch_path_unsafe",
      });
      await expect(readFile(join(codeRoot, "src", "existing.txt"), "utf8"))
        .resolves.toBe("before\n");
    }
  });

  it("rejects a malformed persisted content reference without file I/O", async () => {
    const proposed = await propose({
      kind: "update",
      path: join("src", "existing.txt"),
      proposedContent: "after\n",
    });
    if (proposed.proposal.operation.kind !== "update") {
      throw new Error("Expected update operation.");
    }
    const malformed: ProposedPatchStatus = {
      ...proposed,
      proposal: {
        ...proposed.proposal,
        operation: {
          ...proposed.proposal.operation,
          originalContent: {
            ...proposed.proposal.operation.originalContent,
            digest: "not-a-sha256-digest",
          },
        },
      },
    };

    await expect(materializePatchReview({
      patch: malformed,
      workspaceScope: createScope(),
    })).rejects.toMatchObject({ code: "patch_state_invalid" });
    await expect(readFile(join(codeRoot, "src", "existing.txt"), "utf8"))
      .resolves.toBe("before\n");
  });

  it("enforces trusted content limits during proposal and review", async () => {
    await expect(createPatchProposal(
      proposalInput({
        kind: "create",
        path: join("src", "large.txt"),
        proposedContent: "12345",
      }),
      { ...proposalOptions(), limits: { maxContentBytes: 4 } },
    )).rejects.toBeInstanceOf(PatchWorkflowError);

    const proposed = await propose({
      kind: "create",
      path: join("src", "bounded.txt"),
      proposedContent: "12345",
    });
    await expect(materializePatchReview({
      patch: proposed,
      workspaceScope: createScope(),
      limits: { maxContentBytes: 4 },
    })).rejects.toMatchObject({ code: "patch_state_invalid" });
  });

  function propose(change: PatchProposalChange): Promise<ProposedPatchStatus> {
    return createPatchProposal(proposalInput(change), proposalOptions());
  }

  function proposalInput(change: PatchProposalChange) {
    return {
      workspaceScope: createScope(),
      rootName: "code",
      change,
      summary: "Test patch",
      rationale: "Exercise the patch workflow.",
    };
  }

  function proposalOptions() {
    return {
      now: clock,
      createPatchId: () => "patch-1",
    };
  }

  function createScope(workspaceId = "workspace-code"): TaskWorkspaceScope {
    return {
      roots: { code: createWorkspace(workspaceId, codeRoot) },
      defaultRootName: "code",
    };
  }
});

function createWorkspace(id: string, rootRef: string): WorkspaceContext {
  return {
    id,
    name: id,
    rootRef,
    trustState: "trusted",
    source: "test",
    policyRefs: [],
    metadata: {},
  };
}

function clock(): string {
  return timestamp;
}

async function tryCreateSymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, "file");
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    ) {
      return false;
    }
    throw error;
  }
}
