import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import { ShellExecutionSession } from "./ShellExecutionSession.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("ShellExecutionSession", () => {
  it("continues from a committed child directory and can enter an additional root", async () => {
    const fixture = await createFixture();
    const session = await ShellExecutionSession.create(fixture.workspace, hostPlatform());

    expect(session.snapshot()).toMatchObject({
      revision: 0,
      rootName: "primary",
      relativePath: ".",
    });
    await expect(session.commitFinalWorkingDirectory({
      expectedRevision: 0,
      path: fixture.child,
    })).resolves.toMatchObject({
      revision: 1,
      rootName: "primary",
      relativePath: "child",
    });
    await expect(session.commitFinalWorkingDirectory({
      expectedRevision: 1,
      path: fixture.additional,
    })).resolves.toMatchObject({
      revision: 2,
      rootName: "additional",
      relativePath: ".",
    });
  });

  it("rejects escaped and stale final directories without changing session state", async () => {
    const fixture = await createFixture();
    const session = await ShellExecutionSession.create(fixture.workspace, hostPlatform());

    await expect(session.commitFinalWorkingDirectory({
      expectedRevision: 0,
      path: fixture.outside,
    })).resolves.toBeNull();
    expect(session.snapshot()).toMatchObject({ revision: 0, relativePath: "." });

    await session.commitFinalWorkingDirectory({
      expectedRevision: 0,
      path: fixture.child,
    });
    await expect(session.commitFinalWorkingDirectory({
      expectedRevision: 0,
      path: fixture.primary,
    })).resolves.toBeNull();
    expect(session.snapshot()).toMatchObject({ revision: 1, relativePath: "child" });
  });
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "helarc-shell-session-"));
  temporaryDirectories.push(directory);
  const primary = join(directory, "primary");
  const child = join(primary, "child");
  const additional = join(directory, "additional");
  const outside = join(directory, "outside");
  await Promise.all([
    mkdir(child, { recursive: true }),
    mkdir(additional, { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);
  return {
    primary,
    child,
    additional,
    outside,
    workspace: {
      primary: workspace("primary", primary),
      additional: [workspace("additional", additional)],
    } satisfies WorkspaceSelection,
  };
}

function workspace(id: string, rootRef: string) {
  return {
    id,
    name: id,
    rootRef,
    trustState: "trusted" as const,
    source: "test",
    policyRefs: [],
    metadata: {},
  };
}

function hostPlatform(): "win32" | "posix" {
  return process.platform === "win32" ? "win32" : "posix";
}
