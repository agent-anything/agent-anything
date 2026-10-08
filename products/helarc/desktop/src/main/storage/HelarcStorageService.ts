import { defaultInspectionRoot, inspectionSourceId } from "@agent-anything/inspection/sources";
import { InspectionStorageMaintenance, INSPECTION_STORAGE_POLICY } from "@agent-anything/inspection/storage";
import { snapshotStorageRecordingIds, type HelarcStorageSnapshot, type HelarcStorageCleanupResult } from "../../shared/HelarcStorage.js";
import type { HelarcInspectionSettingsSnapshot } from "../../shared/HelarcInspectionSettings.js";
import { measureHelarcStorage } from "./HelarcStorageUsage.js";

export class HelarcStorageService {
  private readonly maintenance: InspectionStorageMaintenance;
  private tail = Promise.resolve();
  private pending = 0;
  constructor(private readonly userDataPath: string, private readonly health: () => HelarcInspectionSettingsSnapshot["health"], root = defaultInspectionRoot()) {
    this.maintenance = new InspectionStorageMaintenance(root, inspectionSourceId("helarc-desktop"));
  }

  snapshot(): Promise<HelarcStorageSnapshot> {
    return this.serialize(async () => {
      const application = await measureHelarcStorage(this.userDataPath);
      const issues = [...application.issues];
      let bytes: number | null = null;
      let recordings: HelarcStorageSnapshot["inspection"]["recordings"] = [];
      try {
        const inventory = await this.maintenance.inventory();
        bytes = inventory.bytes;
        recordings = inventory.recordings.map(({ datasetId, ...rest }) => ({ id: datasetId, ...rest }));
      } catch { issues.push("Inspection storage could not be measured."); }
      return { measuredAt: new Date().toISOString(), categories: application.categories, issues,
        inspection: { bytes, recordings, sourceLimitBytes: INSPECTION_STORAGE_POLICY.sourceLimitBytes,
          datasetLimitBytes: INSPECTION_STORAGE_POLICY.datasetLimitBytes, health: this.health() } };
    });
  }

  cleanup(ids: readonly string[]): Promise<HelarcStorageCleanupResult> {
    const selected = snapshotStorageRecordingIds(ids);
    return this.serialize(async () => ({ recordings: (await this.maintenance.retire(selected)).map(result => ({
      id: result.datasetId, status: result.status === "removed" ? "removed" : result.status === "active" ? "protected" : "unavailable",
    })) }));
  }

  close(): void { this.maintenance.close(); }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= 4) return Promise.reject(new Error("storage_maintenance_busy"));
    this.pending++;
    const result = this.tail.then(operation).finally(() => { this.pending--; });
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}
