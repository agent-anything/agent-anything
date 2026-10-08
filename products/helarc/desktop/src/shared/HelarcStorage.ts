import type { HelarcInspectionSettingsSnapshot } from "./HelarcInspectionSettings.js";

export interface HelarcStorageCategory {
  readonly id: string;
  readonly name: string;
  readonly bytes: number | null;
  readonly files: number;
}
export interface HelarcStorageRecording {
  readonly id: string;
  readonly createdAt: string | null;
  readonly bytes: number;
  readonly status: "open" | "closed" | "unavailable";
  readonly captureFailure: string | null;
}
export interface HelarcStorageSnapshot {
  readonly measuredAt: string;
  readonly categories: readonly HelarcStorageCategory[];
  readonly inspection: {
    readonly bytes: number | null;
    readonly sourceLimitBytes: number;
    readonly datasetLimitBytes: number;
    readonly recordings: readonly HelarcStorageRecording[];
    readonly health: HelarcInspectionSettingsSnapshot["health"];
  };
  readonly issues: readonly string[];
}
export interface HelarcStorageCleanupResult {
  readonly recordings: readonly { readonly id: string; readonly status: "removed" | "protected" | "unavailable" }[];
}

export function snapshotStorageRecordingIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000 ||
      value.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) ||
      new Set(value).size !== value.length) throw new TypeError("Invalid recording selection.");
  return Object.freeze([...value]);
}
