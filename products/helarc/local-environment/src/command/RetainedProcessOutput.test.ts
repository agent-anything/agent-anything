import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessOutputStore } from "./ProcessOutputStore.js";
import {
  readRetainedProcessOutput,
  registerRetainedProcessOutput,
} from "./RetainedProcessOutput.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function capture() {
  const root = await mkdtemp(join(tmpdir(), "helarc-output-read-"));
  directories.push(root);
  const paths = {
    stdout: join(root, "stdout.raw"),
    stderr: join(root, "stderr.raw"),
    stdoutText: join(root, "stdout.txt"),
    stderrText: join(root, "stderr.txt"),
    manifest: join(root, "manifest.json"),
  };
  const store = await ProcessOutputStore.create(
    "execution",
    paths,
    1024 * 1024,
  );
  store.append("stdout", Buffer.from("\u4e2d".repeat(15000)));
  store.append("stderr", Buffer.from("diagnostic"));
  await store.close();
  return {
    root,
    paths,
    store,
    locator: await registerRetainedProcessOutput("execution", root, paths),
  };
}
describe("retained command output", () => {
  it("pages decoded UTF-8 independently from live cursors with an exact shared bound", async () => {
    const { locator } = await capture();
    let output = "";
    let cursor: string | undefined;
    do {
      const page = await readRetainedProcessOutput(locator, cursor);
      expect(
        Buffer.byteLength(page.stdout.text) +
          Buffer.byteLength(page.stderr.text),
      ).toBeLessThanOrEqual(32768);
      expect(page.stdout.text).not.toContain("\ufffd");
      output += page.stdout.text;
      cursor = page.hasMore ? page.nextCursor : undefined;
    } while (cursor);
    expect(output).toBe("\u4e2d".repeat(15000));
    expect((await readRetainedProcessOutput(locator)).stderr.text).toBe(
      "diagnostic",
    );
  });
  it("rejects replaced files and reports missing capture distinctly", async () => {
    const { locator, paths } = await capture();
    await rename(paths.stdoutText, paths.stdoutText + ".old");
    await writeFile(
      paths.stdoutText,
      await readFile(paths.stdoutText + ".old"),
    );
    await expect(readRetainedProcessOutput(locator)).rejects.toMatchObject({
      reason: "source_changed",
    });
    await rm(paths.stdoutText);
    await expect(readRetainedProcessOutput(locator)).rejects.toMatchObject({
      reason: "missing",
    });
  });
  it("does not register paths outside the recorded workspace", async () => {
    const { root, paths } = await capture();
    await expect(
      registerRetainedProcessOutput("execution", join(root, "another"), paths),
    ).rejects.toThrow();
  });
});
