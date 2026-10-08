import { join } from "node:path";
import { atomicInspectionJson, type InspectionDatasetManifest } from "../sources/index.js";
import type { InspectionDatabase } from "../storage/InspectionDatabase.js";

export function closeFailedInspectionRecording(db: InspectionDatabase, directory: string, manifest: InspectionDatasetManifest, code: string): void {
  try {
    const coverage = db.snapshot();
    const limitation = code === "inspection_storage_budget_exhausted" ? "storage_budget_exhausted" : code;
    db.updateCoverage({ status: "closed", limitations: [...new Set([...coverage.limitations, limitation, "capture_tail_unknown"])] });
    db.checkpoint();
  } finally { db.close(); }
  // Publish closure only after releasing the writer. Closed does not mean complete.
  atomicInspectionJson(join(directory, "manifest.json"), { ...manifest, status: "closed", captureFailure: code });
}
