import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ProcessOutputPaths } from "./ProcessOutputStore.js";

/** Host-owned storage. Neither Workspace selection nor model input chooses paths. */
export class ProcessOutputRepository {
  readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new TypeError("Command output storage requires an absolute Host path.");
    this.root = resolve(root);
  }

  async allocate(runId: string, executionId: string) {
    await this.checkMaintenance();
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertProcessOutputPath(this.root, this.root, true);
    const owners = join(this.root, "owners");
    await mkdir(owners, { recursive: true, mode: 0o700 });
    await assertProcessOutputPath(this.root, owners);
    const owner = join(owners, `${process.pid}.json`);
    try {
      const handle = await open(owner, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid })); }
      finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await assertProcessOutputPath(this.root, owner);
    }
    const run = join(this.root, digest(runId));
    await mkdir(run, { recursive: true, mode: 0o700 });
    await assertProcessOutputPath(this.root, run);
    const directory = join(run, digest(executionId));
    await mkdir(directory, { mode: 0o700 });
    await assertProcessOutputPath(this.root, directory);
    const paths: ProcessOutputPaths = {
      stdout: join(directory, "stdout.raw"), stderr: join(directory, "stderr.raw"),
      stdoutText: join(directory, "stdout.txt"), stderrText: join(directory, "stderr.txt"),
      manifest: join(directory, "manifest.json"),
    };
    const discard = async () => {
      await assertProcessOutputPath(this.root, directory);
      await rm(directory, { recursive: true });
    };
    try {
      // A cleaner may have started after the first check, before our owner claim.
      await this.checkMaintenance();
      // If it already finished, our claim or directory may have been removed.
      await assertProcessOutputPath(this.root, owner);
      await assertProcessOutputPath(this.root, directory);
    } catch (error) {
      await discard().catch(() => {});
      throw error;
    }
    return { paths, discard };
  }

  private async checkMaintenance(): Promise<void> {
    try { await lstat(`${this.root}.cleaning`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new Error("Command output storage is being cleaned.");
  }
}

export async function assertProcessOutputPath(root: string, path: string, allowRoot = false): Promise<void> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Command output storage root was redirected.");
  const canonicalRoot = await realpath(root);
  const target = resolve(path);
  const rel = relative(resolve(root), target);
  if ((!rel && !allowRoot) || rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error("Command output path is outside Host storage.");
  }
  const actual = await realpath(target);
  const expected = resolve(canonicalRoot, rel);
  const same = process.platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
  if (!same || (await lstat(target)).isSymbolicLink()) throw new Error("Command output path was redirected.");
}

function digest(value: string): string {
  if (!value) throw new TypeError("Command output identity is required.");
  return createHash("sha256").update(value).digest("hex");
}
