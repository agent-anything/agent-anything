import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskWorkspaceScope } from "@agent-anything/agent-core";
import type { WorkspaceContext } from "@agent-anything/governance";
import {
  acceptPatch,
  applyAcceptedPatch,
  createPatchProposal,
  materializePatchReview,
  PatchWorkflowError,
  rejectPatch,
  type AcceptedPatchStatus,
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

  it("creates and applies an accepted create patch", async () => {
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
    const result = await apply(acceptPatch(proposed, { now: clock }));

    expect(result).toMatchObject({
      status: "applied",
      result: { status: "applied", patchId: "patch-1" },
    });
    await expect(readFile(join(codeRoot, "src", "created.txt"), "utf8"))
      .resolves.toBe("created\n");
  });

  it("captures a trusted update baseline and applies the replacement", async () => {
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

    const result = await apply(acceptPatch(proposed, { now: clock }));

    expect(result.status).toBe("applied");
    await expect(readFile(join(codeRoot, "src", "existing.txt"), "utf8"))
      .resolves.toBe("after\n");
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

  it("applies an accepted delete patch", async () => {
    const proposed = await propose({
      kind: "delete",
      path: join("src", "delete.txt"),
    });

    expect(proposed.proposal.operation).toMatchObject({
      kind: "delete",
      originalContent: { algorithm: "sha256", byteLength: 10 },
    });
    const result = await apply(acceptPatch(proposed, { now: clock }));

    expect(result.status).toBe("applied");
    await expect(access(join(codeRoot, "src", "delete.txt"))).rejects.toThrow();
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

  it("returns a stale failure when target content changes", async () => {
    const proposed = await propose({
      kind: "update",
      path: join("src", "existing.txt"),
      proposedContent: "after\n",
    });
    await writeFile(join(codeRoot, "src", "existing.txt"), "changed\n");

    const result = await apply(acceptPatch(proposed, { now: clock }));

    expect(result).toMatchObject({
      status: "failed",
      result: { status: "failed", code: "patch_stale" },
    });
    await expect(readFile(join(codeRoot, "src", "existing.txt"), "utf8"))
      .resolves.toBe("changed\n");
  });

  it("returns a stale failure when a create target appears", async () => {
    const proposed = await propose({
      kind: "create",
      path: join("src", "race.txt"),
      proposedContent: "ours\n",
    });
    await writeFile(join(codeRoot, "src", "race.txt"), "theirs\n");

    const result = await apply(acceptPatch(proposed, { now: clock }));

    expect(result).toMatchObject({
      status: "failed",
      result: { code: "patch_stale" },
    });
    await expect(readFile(join(codeRoot, "src", "race.txt"), "utf8"))
      .resolves.toBe("theirs\n");
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

  it("returns invalid-state failures for workspace and decision mismatches", async () => {
    const proposed = await propose({
      kind: "update",
      path: join("src", "existing.txt"),
      proposedContent: "after\n",
    });
    const accepted = acceptPatch(proposed, { now: clock });
    const wrongWorkspace = createScope("workspace-other");

    const workspaceResult = await applyAcceptedPatch({
      patch: accepted,
      workspaceScope: wrongWorkspace,
      now: clock,
    });
    const mismatchedDecision: AcceptedPatchStatus = {
      ...accepted,
      decision: { ...accepted.decision, patchId: "patch-other" },
    };
    const decisionResult = await apply(mismatchedDecision);

    expect(workspaceResult).toMatchObject({
      status: "failed",
      result: { code: "patch_state_invalid" },
    });
    expect(decisionResult).toMatchObject({
      status: "failed",
      result: { code: "patch_state_invalid" },
    });
    await expect(readFile(join(codeRoot, "src", "existing.txt"), "utf8"))
      .resolves.toBe("before\n");
  });

  it("returns a structured application failure when the parent disappears", async () => {
    await mkdir(join(codeRoot, "temporary"));
    const proposed = await propose({
      kind: "create",
      path: join("temporary", "new.txt"),
      proposedContent: "content\n",
    });
    await rm(join(codeRoot, "temporary"), { recursive: true });

    const result = await apply(acceptPatch(proposed, { now: clock }));

    expect(result).toMatchObject({
      status: "failed",
      result: {
        status: "failed",
        code: "patch_apply_failed",
        message: "Patch application failed.",
      },
    });
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

    const result = await apply(acceptPatch(malformed, { now: clock }));

    expect(result).toMatchObject({
      status: "failed",
      result: { code: "patch_state_invalid" },
    });
    await expect(readFile(join(codeRoot, "src", "existing.txt"), "utf8"))
      .resolves.toBe("before\n");
  });

  it("enforces trusted content limits during proposal and application", async () => {
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
    const result = await applyAcceptedPatch({
      patch: acceptPatch(proposed, { now: clock }),
      workspaceScope: createScope(),
      limits: { maxContentBytes: 4 },
      now: clock,
    });

    expect(result).toMatchObject({
      status: "failed",
      result: { code: "patch_state_invalid" },
    });
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

  function apply(patch: AcceptedPatchStatus) {
    return applyAcceptedPatch({
      patch,
      workspaceScope: createScope(),
      now: clock,
    });
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
