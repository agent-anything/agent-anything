import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";
import { containedInspectionPath, validateOpaqueId } from "../sources/index.js";

export interface InspectionStorageMeasurement {
  readonly bytes: number;
  readonly visited: number;
  readonly datasetFiles: readonly (readonly [string, number])[];
}

// Metadata only. Directory facts are rechecked across enumeration, never cached
// as permanent authority for a pathname that another process can replace.
export function scanInspectionSource(root: string, sourceId: string, datasetId?: string, progress?: (visited: number) => void): InspectionStorageMeasurement {
  validateOpaqueId(sourceId);
  if (datasetId) validateOpaqueId(datasetId);
  const source = containedInspectionPath(root, "sources", sourceId);
  const own = datasetId ? join(source, "datasets", datasetId) : null;
  const datasetFiles: [string, number][] = [];
  let bytes = 0;
  let visited = 0;
  let lastProgress = Date.now();
  const tick = () => {
    if (++visited > 100_000) throw new Error("inspection_storage_scan_limit");
    if (visited % 128 === 0 || Date.now() - lastProgress >= 250) {
      progress?.(visited); lastProgress = Date.now();
    }
  };
  const inspect = (path: string): Stats | null => {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("inspection_path_invalid");
      return stat;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && path !== source) return null;
      throw error;
    }
  };
  const checkDirectory = (path: string, before: Stats): boolean => {
    containedInspectionPath(root, "sources", sourceId, relative(source, path));
    const after = inspect(path);
    if (!after) return false;
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) throw new Error("inspection_path_invalid");
    return true;
  };
  const walk = (path: string, depth: number): void => {
    if (depth > 32) throw new Error("inspection_storage_scan_limit");
    const stat = inspect(path);
    tick();
    if (!stat) return;
    if (!stat.isDirectory()) {
      if (!stat.isFile()) throw new Error("inspection_path_invalid");
      bytes += stat.size;
      if (own && path.startsWith(own + sep)) datasetFiles.push([relative(own, path), stat.size]);
      return;
    }
    if (!checkDirectory(path, stat)) return;
    let entries: string[];
    try { entries = readdirSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && path !== source) return; throw error; }
    if (entries.length + visited > 100_000) throw new Error("inspection_storage_scan_limit");
    for (let i = 0; i < entries.length; i++) {
      if (i % 128 === 0 && !checkDirectory(path, stat)) return;
      walk(join(path, entries[i]!), depth + 1);
    }
    checkDirectory(path, stat);
  };
  walk(source, 0);
  progress?.(visited);
  return { bytes, visited, datasetFiles };
}
