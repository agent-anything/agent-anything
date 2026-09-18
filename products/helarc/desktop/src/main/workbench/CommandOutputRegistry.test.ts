import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CommandOutputRegistry } from "./CommandOutputRegistry.js";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
it("retains exact ownership across restart without granting cross-Run access", async () => {
  const root = await mkdtemp(join(tmpdir(), "helarc-locator-"));
  directories.push(root);
  const path = join(root, "locators.json");
  const paths = {
    stdout: join(root, "stdout.raw"),
    stderr: join(root, "stderr.raw"),
    stdoutText: join(root, "stdout.txt"),
    stderrText: join(root, "stderr.txt"),
    manifest: join(root, "manifest.json"),
  };
  await writeFile(paths.stdoutText, "hello");
  await writeFile(paths.stderrText, "");
  await writeFile(
    paths.manifest,
    JSON.stringify({
      executionId: "exec",
      generation: 1,
      persistenceFailure: null,
      streams: {
        stdout: {
          textBytes: 5,
          omittedBytes: 0,
          projection: {
            encoding: "utf-8",
            integrity: "exact",
            replacementCount: 0,
          },
        },
        stderr: {
          textBytes: 0,
          omittedBytes: 0,
          projection: {
            encoding: "utf-8",
            integrity: "exact",
            replacementCount: 0,
          },
        },
      },
    }),
  );
  const scope = { threadId: "thread", productRunId: "product", runId: "run" };
  await new CommandOutputRegistry(path).register(scope, "exec", root, paths);
  const reopened = new CommandOutputRegistry(path);
  expect(
    await reopened.read(
      { ...scope, executionId: "exec", cursor: null },
      undefined,
    ),
  ).toMatchObject({ status: "page", stdout: { text: "hello" } });
  expect(
    await reopened.read(
      { ...scope, runId: "other", executionId: "exec", cursor: null },
      undefined,
    ),
  ).toEqual({ status: "unavailable", reason: "not_retained" });
});
