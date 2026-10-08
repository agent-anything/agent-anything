import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HelarcStorageCategory } from "../../shared/HelarcStorage.js";

const groups = [
  ["conversations", "Conversations and transcripts"],
  ["command-output", "Command output"],
  ["qualification", "Model qualification"],
  ["cache", "Application cache"],
  ["configuration", "Configuration and other app data"],
] as const;

export async function measureHelarcStorage(userDataPath: string): Promise<{ categories: readonly HelarcStorageCategory[]; issues: readonly string[] }> {
  const totals = new Map<string, { id: string; name: string; bytes: number | null; files: number }>(groups.map(([id, name]) => [id, { id, name, bytes: 0, files: 0 }]));
  let root = resolve(userDataPath);
  const issues: string[] = [];
  const deadline = Date.now() + 30_000;
  let visited = 0;
  const check = () => { if (++visited > 100_000 || Date.now() > deadline) throw new Error("storage_scan_limit"); };
  const inside = async (path: string) => {
    const rel = relative(root, await realpath(path));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("storage_path_invalid");
  };
  const walk = async (path: string, id: string, depth: number): Promise<void> => {
    check();
    if (depth > 32) throw new Error("storage_scan_limit");
    let stat;
    try { stat = await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (stat.isSymbolicLink()) throw new Error("storage_path_invalid");
    const total = totals.get(id)!;
    if (stat.isFile()) { if (total.bytes !== null) total.bytes += stat.size; total.files++; return; }
    if (!stat.isDirectory()) throw new Error("storage_path_invalid");
    await inside(path);
    for (const name of await readdir(path)) await walk(join(path, name), id, depth + 1);
    await inside(path);
  };
  try {
    if ((await lstat(root)).isSymbolicLink()) throw new Error("storage_path_invalid");
    root = await realpath(root);
    await inside(root);
    for (const name of await readdir(root)) {
      const id = category(name);
      try { await walk(join(root, name), id, 0); }
      catch { totals.get(id)!.bytes = null; if (!issues.includes(id)) issues.push(id); }
    }
  } catch {
    for (const total of totals.values()) total.bytes = null;
    issues.push("application-data");
  }
  return { categories: [...totals.values()], issues: issues.map(id => `Usage is unavailable or incomplete for ${id}.`) };
}

function category(name: string): string {
  if (["threads.json", "run-transcripts", "context-manifests.json", "model-continuations.json"].includes(name)) return "conversations";
  if (name === "command-output") return "command-output";
  if (name === "model-qualification.json") return "qualification";
  if (["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "ShaderCache", "GrShaderCache"].includes(name)) return "cache";
  return "configuration";
}
