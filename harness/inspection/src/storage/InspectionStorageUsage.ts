import { lstatSync } from "node:fs";
import { containedInspectionPath } from "../sources/index.js";
import type { InspectionStorageMeasurement } from "./InspectionStorageScan.js";

export class InspectionStorageUsage {
  private files = new Map<string, number>();
  private localBytes = 0;
  private externalBytes: number;
  private duringScan: Map<string, number> | null = null;

  constructor(baseline: InspectionStorageMeasurement) {
    this.files = new Map(baseline.datasetFiles);
    this.localBytes = [...this.files.values()].reduce((sum, bytes) => sum + bytes, 0);
    this.externalBytes = baseline.bytes - this.localBytes;
  }
  get datasetBytes(): number { return this.localBytes; }
  get sourceBytes(): number { return this.externalBytes + this.localBytes; }

  physicalFileChanged(path: string, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("inspection_storage_unavailable");
    this.localBytes += bytes - (this.files.get(path) ?? 0);
    if (bytes) this.files.set(path, bytes); else this.files.delete(path);
    this.duringScan?.set(path, bytes);
    if (this.files.size > 100_000 || (this.duringScan?.size ?? 0) > 100_000) throw new Error("inspection_storage_scan_limit");
  }

  refreshDatabase(directory: string): void {
    for (const name of ["inspection.sqlite", "inspection.sqlite-wal", "inspection.sqlite-shm", "manifest.json"]) {
      const path = containedInspectionPath(directory, name);
      let bytes = 0;
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("inspection_path_invalid");
        bytes = stat.size;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      this.physicalFileChanged(name, bytes);
    }
  }

  beginReconciliation(): void {
    if (this.duringScan) throw new Error("inspection_storage_scan_overlap");
    this.duringScan = new Map();
  }
  reconcile(measurement: InspectionStorageMeasurement): void {
    if (!this.duringScan) throw new Error("inspection_storage_scan_missing");
    const changes = this.duringScan;
    this.duringScan = null;
    this.files = new Map(measurement.datasetFiles);
    this.localBytes = [...this.files.values()].reduce((sum, bytes) => sum + bytes, 0);
    this.externalBytes = measurement.bytes - this.localBytes;
    for (const [path, bytes] of changes) this.physicalFileChanged(path, bytes);
  }
  check(additional = 0): void {
    if (this.datasetBytes + additional > 511 * 1024 * 1024 || this.sourceBytes + additional > 2047 * 1024 * 1024) {
      throw new Error("inspection_storage_budget_exhausted");
    }
  }
}
