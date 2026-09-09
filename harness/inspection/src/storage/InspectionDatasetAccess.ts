import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { containedInspectionPath } from "../sources/index.js";

const LEASE_MS = 10000;

export function acquireInspectionReadLease(directory: string): () => void {
  const retiring = containedInspectionPath(directory, "retiring.lock");
  if (!existsSync(directory) || existsSync(retiring)) throw new Error("inspection_dataset_unavailable");
  const readers = containedInspectionPath(directory, "readers");
  mkdirSync(readers, { recursive: true, mode: 0o700 });
  const file = containedInspectionPath(readers, randomUUID() + ".lease");
  writeFileSync(file, "", { flag: "wx", mode: 0o600 });
  const release = () => { try { unlinkSync(file); } catch { /* Expired or already retired leases have no authority. */ } };
  if (existsSync(retiring) || !existsSync(directory)) { release(); throw new Error("inspection_dataset_unavailable"); }
  return release;
}

export function acquireInspectionRetirement(directory: string): (() => void) | null {
  const marker = containedInspectionPath(directory, "retiring.lock");
  let fd: number;
  try { fd = openSync(marker, "wx", 0o600); } catch { return null; }
  closeSync(fd);
  const release = () => { try { unlinkSync(marker); } catch { /* Dataset removal includes the marker. */ } };
  const readers = containedInspectionPath(directory, "readers");
  try {
    if (existsSync(readers)) for (const name of readdirSync(readers)) {
      const path = containedInspectionPath(readers, name);
      try {
        if (Date.now() - statSync(path).mtimeMs < LEASE_MS) { release(); return null; }
        unlinkSync(path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return release;
  } catch { release(); return null; }
}
