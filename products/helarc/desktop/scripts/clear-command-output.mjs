import { lstat, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Offline maintenance only: a live Host may still read or register output. */
export async function clearCommandOutput(userDataPath, { dryRun = false, log = console.log } = {}) {
  const root = resolve(userDataPath, "command-output");
  if (!(await exists(userDataPath))) return;
  await assertDirectory(userDataPath);
  const lockPath = `${root}.cleaning`;
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Command output cleanup is already locked. Check for an unfinished cleanup before removing its lock.");
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    if (!(await exists(root))) return;
    await assertDirectory(root);
    const owners = join(root, "owners");
    if (await exists(owners)) {
      await assertDirectory(owners);
      for (const name of await readdir(owners)) {
        const path = join(owners, name);
        const stat = await lstat(path);
        if (!/^\d+\.json$/u.test(name) || !stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) {
          throw new Error("Command output owner record is invalid; cleanup refused.");
        }
        const owner = JSON.parse(await readFile(path, "utf8"));
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || name !== `${owner.pid}.json`) {
          throw new Error("Command output owner identity is invalid; cleanup refused.");
        }
        if (isAlive(owner.pid)) throw new Error("Close Helarc before cleaning command output: its storage is still owned by a live process.");
      }
    }
    // Do not traverse redirected descendants, even though rm does not follow links.
    await rejectLinks(root);
    if (dryRun) log(`Would delete Helarc command output: ${root}`);
    else {
      await rm(root, { recursive: true, force: true });
      log(`Deleted Helarc command output: ${root}`);
    }
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function assertDirectory(path) {
  const stat = await lstat(path);
  const actual = await realpath(path);
  const expected = join(await realpath(dirname(path)), basename(path));
  const same = process.platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
  if (!stat.isDirectory() || stat.isSymbolicLink() || !same) throw new Error("Refusing cleanup through a redirected storage directory.");
}
async function rejectLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Refusing cleanup of redirected command output.");
    if (entry.isDirectory()) { await assertDirectory(path); await rejectLinks(path); }
  }
}
function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}
