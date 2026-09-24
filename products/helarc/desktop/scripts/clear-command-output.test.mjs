import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { clearCommandOutput } from "./clear-command-output.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "helarc-output-clean-")); roots.push(root);
  const userData = join(root, "Helarc");
  const output = join(userData, "command-output");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "locators.json"), "{}");
  await writeFile(join(userData, "threads.json"), "keep");
  return { root, userData, output };
}
it("previews then removes only managed output, including incomplete crash remnants", async () => {
  const { userData, output } = await fixture();
  await mkdir(join(output, "unfinished"));
  await writeFile(join(output, "unfinished", "stdout.raw"), "partial");
  await clearCommandOutput(userData, { dryRun: true, log: () => {} });
  await expect(access(output)).resolves.toBeUndefined();
  await clearCommandOutput(userData, { log: () => {} });
  await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(userData, "threads.json"), "utf8")).toBe("keep");
});
it("refuses live Host ownership and releases its cleanup lock", async () => {
  const { userData, output } = await fixture();
  await mkdir(join(output, "owners"));
  await writeFile(join(output, "owners", `${process.pid}.json`), JSON.stringify({ pid: process.pid }));
  await expect(clearCommandOutput(userData)).rejects.toThrow("Close Helarc");
  await expect(access(output)).resolves.toBeUndefined();
  await expect(access(`${output}.cleaning`)).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses redirected directories and another cleanup", async () => {
  const { root, userData, output } = await fixture();
  await writeFile(`${output}.cleaning`, "locked");
  await expect(clearCommandOutput(userData)).rejects.toThrow("locked");
  await rm(`${output}.cleaning`);
  const other = join(root, "workspace"); await mkdir(other);
  await writeFile(join(other, "keep.txt"), "keep");
  await symlink(other, join(output, "redirect"), process.platform === "win32" ? "junction" : "dir");
  await expect(clearCommandOutput(userData)).rejects.toThrow("redirected");
  expect(await readFile(join(other, "keep.txt"), "utf8")).toBe("keep");
});
