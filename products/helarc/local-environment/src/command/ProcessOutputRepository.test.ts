import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProcessOutputRepository } from "./ProcessOutputRepository.js";
import { ProcessOutputStore } from "./ProcessOutputStore.js";
import { registerRetainedProcessOutput, readRetainedProcessOutput } from "./RetainedProcessOutput.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "helarc-output-repository-")); roots.push(root);
  const output = join(root, "command-output");
  return { root, output, repository: new ProcessOutputRepository(output) };
}
it("allocates distinct Run/execution storage and reopens settled output", async () => {
  const { repository, output } = await fixture();
  const first = await repository.allocate("run", "command");
  const second = await repository.allocate("child", "command");
  expect(first.paths.stdout).not.toBe(second.paths.stdout);
  expect(relative(output, first.paths.stdout).startsWith("..")).toBe(false);
  await expect(repository.allocate("run", "command")).rejects.toMatchObject({ code: "EEXIST" });
  const store = await ProcessOutputStore.create("command", first.paths, 1024);
  store.append("stdout", Buffer.from("hello")); await store.close();
  const locator = await registerRetainedProcessOutput("command", output, first.paths);
  expect((await readRetainedProcessOutput(JSON.parse(JSON.stringify(locator)))).stdout.text).toBe("hello");
  expect((await readdir(join(output, "owners")))).toContain(`${process.pid}.json`);
  await second.discard();
  await expect(access(second.paths.stdout)).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects maintenance and redirected storage without writing through them", async () => {
  const { root, output, repository } = await fixture();
  await writeFile(`${output}.cleaning`, "maintenance");
  await expect(repository.allocate("run", "command")).rejects.toThrow("cleaned");
  await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  await rm(`${output}.cleaning`);
  await mkdir(output); const other = join(root, "other"); await mkdir(other);
  const runKey = createHash("sha256").update("run").digest("hex");
  await symlink(other, join(output, runKey), process.platform === "win32" ? "junction" : "dir");
  await expect(repository.allocate("run", "command")).rejects.toThrow("redirected");
  expect(await readdir(other)).toEqual([]);
});
it("cleans only newly created files on partial capture creation failure", async () => {
  const { repository } = await fixture();
  const { paths } = await repository.allocate("run", "command");
  await writeFile(paths.stderr, "existing");
  await expect(ProcessOutputStore.create("command", paths, 1024)).rejects.toMatchObject({ code: "EEXIST" });
  await expect(access(paths.stdout)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(paths.stderr, "utf8")).toBe("existing");
});
it("does not register an unfinished capture as retained output", async () => {
  const { output, repository } = await fixture();
  const { paths } = await repository.allocate("run", "command");
  const store = await ProcessOutputStore.create("command", paths, 1024);
  await expect(registerRetainedProcessOutput("command", output, paths)).rejects.toMatchObject({ reason: "incomplete_manifest" });
  await store.close();
});
